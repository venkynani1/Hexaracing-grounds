import { Suspense, lazy } from 'react';
import { useWorldMap } from '../game/useWorldMap';

const TestDrive = lazy(() => import('../game/TestDrive'));

/** /test-drive — offline visual-quality checkpoint on the real Chennai map (never touches the event). */
export function TestDrivePage() {
  const map = useWorldMap('chennai');
  if (!map) return <div className="page narrow">Loading Chennai…</div>;
  return (
    <Suspense fallback={<div className="page narrow">Loading renderer…</div>}>
      <TestDrive map={map} />
    </Suspense>
  );
}
