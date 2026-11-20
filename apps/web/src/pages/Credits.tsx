import { Brand } from '../components';

/** Credits and data licences (SPEC Part 2.2, NON-NEGOTIABLE 5). */
export function Credits() {
  return (
    <main className="page narrow credits" data-testid="credits">
      <Brand small />
      <h1>Credits</h1>
      <h2>Map data</h2>
      <p>
        Road network and reference locations: <b>© OpenStreetMap contributors</b>, available under the{' '}
        <a href="https://opendatacommons.org/licenses/odbl/1-0/">Open Database License (ODbL) 1.0</a>. See{' '}
        <a href="https://www.openstreetmap.org/copyright">openstreetmap.org/copyright</a>.
      </p>
      <p>
        Extract: OpenStreetMap Tamil Nadu (download.openstreetmap.fr), snapshot 17 Nov 2026. The derived game map (road centrelines,
        classes, lanes, one-way flags, signals, verified start locations and courses) is made available under the ODbL as well.
      </p>
      <p>
        Chennai is shown at a <b>uniform 85% scale</b> so the 60-minute event fits; relative geography is preserved. Not every lane,
        building or structure is geographically exact. Buildings, vehicles and all visuals are original procedural content.
      </p>
      <h2>Software</h2>
      <ul>
        <li>Babylon.js (Apache-2.0), React (MIT), Vite (MIT), Fastify (MIT), ws (MIT), Drizzle ORM (Apache-2.0), PGlite (Apache-2.0)</li>
      </ul>
      <h2>Disclaimer</h2>
      <p>CODE REDLINE is an original game. Any offer letter it produces is a COMMEMORATIVE GAME OFFER LETTER — NOT AN EMPLOYMENT OFFER.</p>
      <p>
        <a href="/">Back</a>
      </p>
    </main>
  );
}
