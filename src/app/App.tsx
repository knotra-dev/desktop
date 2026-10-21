import { useEffect, useState } from 'react';
import { preferredLocale, translate } from '../lib/i18n';
import { loadWorkspace, type State } from '../lib/storage';
import { WorkspaceApp } from './WorkspaceApp';
import { WorkspaceRecovery } from './WorkspaceRecovery';

export default function App() {
  const [initial, setInitial] = useState<State>();
  const [error, setError] = useState('');
  const locale = preferredLocale();

  useEffect(() => {
    void loadWorkspace()
      .then(setInitial)
      .catch((error) => setError(error instanceof Error ? error.message : String(error)));
  }, []);
  if (error)
    return (
      <WorkspaceRecovery
        error={error}
        onRestore={(value) => {
          setError('');
          setInitial(value);
        }}
      />
    );
  if (!initial)
    return (
      <div className="loading text-muted p-12.5" role="status">
        {translate('shell.openingLocalWorkspace', locale)}
      </div>
    );

  return <WorkspaceApp initial={initial} />;
}
