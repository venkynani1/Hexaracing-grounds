import { Suspense, lazy } from 'react';
import { useWorldMap } from '../game/useWorldMap';

const SliceDrive = lazy(() => import('../game/slice/SliceDrive'));

/** /slice — the visual vertical slice + on-device acceptance test (offline; never touches the event). */
export function SlicePage() {
  const map = useWorldMap('chennai');
  if (!map) return <div className="page narrow">Loading Chennai…</div>;
  return (
    <Suspense fallback={<div className="page narrow">Loading renderer…</div>}>
      <SliceDrive map={map} />
    </Suspense>
  );
}
