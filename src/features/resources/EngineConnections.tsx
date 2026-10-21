import { Bot, Box, KeyRound, Wrench } from 'lucide-react';
import type { Profile, Resource } from '../../lib/engine/types';
import { type MessageKey, useI18n } from '../../lib/i18n';
import type { SavedConnection, SavedMcpConnection } from '../../lib/setup';
import { DataBlock } from '../engine/execution/DataBlock';

const kinds = {
  model: { icon: Bot, label: 'resources.modelSource', description: 'resources.forAiSteps' },
  sandbox: { icon: Box, label: 'resources.codeEnvironment', description: 'resources.forCodeSteps' },
  mcp: { icon: Wrench, label: 'resources.connectedTools', description: 'resources.forToolSteps' },
  secret: {
    icon: KeyRound,
    label: 'resources.secretReference',
    description: 'resources.forSecretInputs',
  },
} satisfies Record<
  Resource['kind'],
  { icon: typeof Bot; label: MessageKey; description: MessageKey }
>;

const capabilityLabels: Record<string, MessageKey> = {
  'files.read': 'resources.readFiles',
  'files.write': 'resources.writeFiles',
  'process.exec': 'resources.runCommands',
};

export function EngineConnections({
  resources,
  profiles,
  sources,
  mcpSources = [],
}: {
  resources: Resource[];
  profiles: Profile[];
  sources: SavedConnection[];
  mcpSources?: SavedMcpConnection[];
}) {
  const { t } = useI18n();
  return (
    <section
      className="engine-connections settings-card mb-6 max-w-250 rounded-[16px] border border-solid border-line bg-surface p-6"
      aria-label={t('resources.engineConnections')}
    >
      <h2 className="m-0 text-[18px] font-medium text-foreground">
        {t('resources.engineConnections')}
      </h2>
      <p className="mt-2 mb-4 text-[12px] leading-5 text-secondary">
        {t('resources.chooseConnectionsInSteps')}
      </p>
      {resources.length ? (
        <ul className="m-0 list-none p-0">
          {resources.map((resource) => {
            const meta = kinds[resource.kind];
            const Icon = meta.icon;
            const source =
              ['model', 'mcp'].includes(resource.kind) &&
              resource.title === `local / ${resource.id}`
                ? (resource.kind === 'model' ? sources : mcpSources).find(
                    (source) => source.id === resource.id,
                  )
                : undefined;
            const generatedTitle =
              resource.title === resource.id || resource.title.endsWith(` / ${resource.id}`);
            const opaque =
              /^(?:source|model|connection|mcp)_[a-f0-9]{12,}$/i.test(resource.id) ||
              /^[a-f0-9]{8}(?:-?[a-f0-9]{4}){3}-?[a-f0-9]{12}$/i.test(resource.id);
            const title =
              source?.title ||
              (!generatedTitle ? resource.title : undefined) ||
              (resource.kind === 'sandbox' && resource.id === 'node_box'
                ? t('resources.nodeSandbox')
                : undefined) ||
              (resource.kind === 'sandbox' && resource.id === 'python_box'
                ? t('resources.pythonSandbox')
                : undefined) ||
              (opaque
                ? t(meta.label)
                : resource.id
                    .replace(/[_-]+/g, ' ')
                    .replace(/^./, (letter) => letter.toUpperCase()));
            const profileId =
              generatedTitle && resource.title.endsWith(` / ${resource.id}`)
                ? resource.title.slice(0, -` / ${resource.id}`.length)
                : undefined;
            const profile = profiles.find((profile) => profile.id === profileId);
            const capabilities = resource.capabilities.filter((capability) =>
              Object.hasOwn(capabilityLabels, capability),
            );
            return (
              <li
                className="engine-connection grid min-w-0 grid-cols-[1.25rem_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 border-t border-solid border-line py-4"
                key={JSON.stringify([resource.kind, resource.title, resource.id])}
              >
                <Icon size={18} className="mt-0.5 text-secondary" aria-hidden="true" />
                <div className="min-w-0">
                  <h3 className="m-0 text-[13px] font-semibold leading-5 text-foreground wrap-anywhere">
                    {title}
                  </h3>
                  <p className="mt-1 mb-0 text-[12px] leading-5 text-secondary">
                    {t(meta.description)}
                  </p>
                  {profiles.length > 1 && profile ? (
                    <p className="mt-1 mb-0 text-[11px] leading-5 text-muted">{profile.title}</p>
                  ) : null}
                  {capabilities.length ? (
                    <p className="mt-1 mb-0 text-[11px] leading-5 text-secondary">
                      {capabilities
                        .map((capability) => t(capabilityLabels[capability]))
                        .join(' · ')}
                    </p>
                  ) : null}
                </div>
                <span
                  className={`text-[11px] leading-5 ${resource.status === 'available' ? 'text-secondary' : 'text-amber'}`}
                >
                  {t(
                    resource.status === 'available'
                      ? 'resources.configured'
                      : 'resources.needsSetup',
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="py-4 text-[13px] leading-5 text-secondary" role="status">
          {t('resources.engineConnectionsEmpty')}
        </p>
      )}
      <p className="mt-1 mb-3 text-[11px] leading-5 text-muted">
        {t('resources.connectionsCheckedOnRun')}
      </p>
      <DataBlock label={t('resources.engineTechnicalDetails')} value={resources} />
    </section>
  );
}
