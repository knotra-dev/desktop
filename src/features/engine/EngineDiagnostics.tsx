import type { EngineDiagnostic } from '../../lib/engine/types';

export function Diagnostics({ diagnostics }: { diagnostics: EngineDiagnostic[] }) {
  return (
    <div className="engine-diagnostics">
      {diagnostics.map((diagnostic) => (
        <div
          className={`diagnostic flex gap-3 border-b border-solid border-b-line text-secondary px-0 py-3.25 diagnostic-${diagnostic.severity}`}
          key={JSON.stringify(diagnostic)}
        >
          <div>
            <strong>{diagnostic.code}</strong>
            <p>{diagnostic.message}</p>
            <code>
              {diagnostic.file
                ? `${diagnostic.file}:${diagnostic.line}:${diagnostic.column} · `
                : ''}
              {diagnostic.path} · {diagnostic.phase}
            </code>
          </div>
        </div>
      ))}
    </div>
  );
}
