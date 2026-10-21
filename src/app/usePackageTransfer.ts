import { unzipSync, zipSync } from 'fflate';
import { type Dispatch, type SetStateAction, useRef, useState } from 'react';
import { base64, decodeText, textBytes, unbase64 } from '../lib/bytes';
import type { TranslationValues } from '../lib/i18n';
import {
  browserPackage,
  desktop,
  exportPackage,
  type OpenedPackage,
  openPackage,
} from '../lib/native';
import { allowedFiles } from '../lib/package';
import type { Workspace } from '../lib/types';
import { parsePipeline, type validatePipeline, validPath } from '../lib/validation';
import type { WorkspaceDialog } from './WorkspaceDialogs';

export function usePackageTransfer(
  workspace: Workspace | undefined,
  validation: ReturnType<typeof validatePipeline>,
  addWorkspace: (opened: OpenedPackage) => void,
  setDialog: Dispatch<SetStateAction<WorkspaceDialog>>,
  notify: (message: string, values?: TranslationValues) => void,
) {
  const [busy, setBusy] = useState(false);
  const [pendingPackage, setPendingPackage] = useState<OpenedPackage>();
  const [entries, setEntries] = useState<string[]>([]);
  const [pickedEntry, setPickedEntry] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  async function importNative() {
    setBusy(true);

    try {
      const opened = await openPackage();
      if (opened) addWorkspace(opened);
    } catch (e) {
      notify(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function importBrowser(files: File[]) {
    if (!files.length) return;

    setBusy(true);

    try {
      let opened: OpenedPackage;
      if (files.length === 1 && files[0].name.toLowerCase().endsWith('.zip')) {
        if (files[0].size > 64 * 1024 * 1024) throw new Error('Archive exceeds 64 MiB.');
        let size = 0;
        let count = 0;
        const paths = new Set<string>();
        const bytes = unzipSync(new Uint8Array(await files[0].arrayBuffer()), {
          filter: (file) => {
            if (file.name.endsWith('/')) return false;

            size += file.originalSize;
            count++;
            if (count > 512 || size > 64 * 1024 * 1024 || !validPath(file.name))
              throw new Error('Archive exceeds package limits or contains an invalid path.');

            const folded = file.name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
            if (paths.has(folded)) throw new Error(`Duplicate package path: ${file.name}`);
            paths.add(folded);
            return true;
          },
        });
        const packageFiles = Object.entries(bytes).map(([path, content]) => ({
          path,
          content: base64(content),
        }));

        const candidates = packageFiles.filter((f) => /\.ya?ml$/i.test(f.path));
        if (!candidates.length) throw new Error('Archive has no YAML entrypoint.');
        opened = {
          entrypoint: candidates[0].path,
          source: decodeText(candidates[0].content),
          files: packageFiles.filter((f) => f.path !== candidates[0].path),
        };
      } else {
        if (files.length > 512 || files.reduce((n, f) => n + f.size, 0) > 64 * 1024 * 1024)
          throw new Error('Selection exceeds 512 files or 64 MiB.');
        const first = files.find((f) => /\.ya?ml$/i.test(f.name));
        if (!first) throw new Error('Select a YAML pipeline or a ZIP package.');
        const entrypoint = first.webkitRelativePath
          ? first.webkitRelativePath.split('/').slice(1).join('/')
          : first.name;
        opened = await browserPackage(files, entrypoint);
      }

      const all = [
        { path: opened.entrypoint, content: base64(textBytes(opened.source)) },
        ...opened.files,
      ];
      const paths = new Set<string>();
      for (const file of all) {
        if (!validPath(file.path)) throw new Error(`Invalid package path: ${file.path}`);
        const folded = file.path.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
        if (paths.has(folded)) throw new Error(`Duplicate package path: ${file.path}`);
        paths.add(folded);
      }

      const candidates = all
        .filter(
          (f) =>
            /\.ya?ml$/i.test(f.path) &&
            (() => {
              try {
                return Boolean(parsePipeline(decodeText(f.content)));
              } catch {
                return false;
              }
            })(),
        )
        .map((f) => f.path);
      if (candidates.length > 1) {
        setPendingPackage(opened);
        setEntries(candidates);
        setPickedEntry(candidates.includes('pipeline.yaml') ? 'pipeline.yaml' : candidates[0]);
        setDialog('entrypoint');
      } else if (candidates.length === 1) {
        const entrypoint = candidates[0];
        const file = all.find((file) => file.path === entrypoint);
        if (!file) throw new Error('Package entrypoint is unavailable.');
        addWorkspace(
          allowedFiles({
            entrypoint,
            source: decodeText(file.content),
            files: all.filter((file) => file.path !== entrypoint),
          }),
        );
      } else throw new Error('Package has no Pipeline YAML entrypoint.');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function confirmEntry() {
    if (!pendingPackage) return;

    const all = [
      { path: pendingPackage.entrypoint, content: base64(textBytes(pendingPackage.source)) },
      ...pendingPackage.files,
    ];
    const file = all.find((f) => f.path === pickedEntry);
    if (!file) return;

    addWorkspace(
      allowedFiles({
        entrypoint: pickedEntry,
        source: decodeText(file.content),
        files: all.filter((f) => f.path !== pickedEntry),
      }),
    );
    setPendingPackage(undefined);
  }

  async function exportCurrent() {
    if (!workspace) return;

    setBusy(true);

    try {
      if (validation.diagnostics.some((d) => d.severity === 'error'))
        throw new Error(
          'Resolve the local validation errors before exporting a runnable package. You can still save the draft or export a workspace backup.',
        );

      const name = validation.pipeline?.metadata.name ?? 'pipeline';
      const declared = allowedFiles({
        entrypoint: workspace.entrypoint,
        source: workspace.source,
        files: workspace.files,
      });

      if (desktop) {
        const path = await exportPackage(
          declared.entrypoint,
          declared.source,
          declared.files,
          name,
        );
        if (path) notify('messages.packageExportedToPath', { path });
      } else {
        const entries = Object.fromEntries(
          [
            { path: workspace.entrypoint, content: base64(textBytes(workspace.source)) },
            ...declared.files,
          ].map((f) => [f.path, unbase64(f.content)]),
        );

        const zipped = zipSync(entries);
        const url = URL.createObjectURL(
          new Blob([Uint8Array.from(zipped).buffer], { type: 'application/zip' }),
        );
        const a = document.createElement('a');
        a.href = url;
        a.download = `${name}.zip`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        notify('messages.completePipelinePackageExportedAsZip');
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function openImport() {
    if (desktop) void importNative();
    else setDialog('import');
  }

  return {
    busy,
    fileInput,
    folderInput,
    entries,
    pickedEntry,
    setPickedEntry,
    importBrowser,
    confirmEntry,
    exportCurrent,
    openImport,
  };
}
