import { usePath } from './lib/router';
import { Home } from './pages/Home';
import { Lobby } from './pages/Lobby';
import { Host } from './pages/Host';

export function App() {
  const path = usePath();
  if (path.startsWith('/host')) return <Host />;
  if (path.startsWith('/lobby')) return <Lobby />;
  const m = path.match(/^\/join\/([A-Za-z0-9-]{1,12})/);
  return <Home initialCode={m?.[1]?.toUpperCase() ?? ''} />;
}
