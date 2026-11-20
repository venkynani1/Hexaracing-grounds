import { usePath } from './lib/router';
import { Home } from './pages/Home';
import { Lobby } from './pages/Lobby';
import { Host } from './pages/Host';
import { Credits } from './pages/Credits';
import { Projector } from './pages/Projector';
import { TestDrivePage } from './pages/TestDrivePage';

export function App() {
  const path = usePath();
  if (path.startsWith('/credits')) return <Credits />;
  if (path.startsWith('/test-drive')) return <TestDrivePage />;
  if (path.startsWith('/projector')) return <Projector />;
  if (path.startsWith('/host')) return <Host />;
  if (path.startsWith('/lobby')) return <Lobby />;
  const m = path.match(/^\/join\/([A-Za-z0-9-]{1,12})/);
  return <Home initialCode={m?.[1]?.toUpperCase() ?? ''} />;
}
