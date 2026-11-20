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
        building or structure is geographically exact. Building placement is procedural (shared with the server's collision); buildings are not real-world replicas.
      </p>
      <h2>3D assets &amp; textures</h2>
      <ul data-testid="asset-credits">
        <li>
          Squad and traffic cars: “Car Concept” by Eric Chadwick / Darmstadt Graphics Group GmbH, from a CC0 model by “Unity Fan” —{' '}
          <a href="https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CarConcept">Khronos glTF Sample Assets</a>, licensed{' '}
          <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>. Modified: trademarks/logos removed, original number plate, simplified LODs,
          recoloured per squad. Not affiliated with or endorsed by the Khronos Group.
        </li>
        <li>Sky &amp; lighting: “Kloofendal 48d Partly Cloudy (Pure Sky)” by Greg Zaal &amp; Jarod Guest — Poly Haven, CC0.</li>
        <li>Asphalt, pavers, concrete, grass textures and the concrete road barrier: Poly Haven (Dimitrios Savva, Charlotte Baglioni, Rob Tuytel, Amal Kumar), CC0.</li>
        <li>Building facades: ambientCG (Facade001, Facade006, Facade018A, Facade019A), CC0.</li>
        <li>Everything else (street lights, palms, kerb paint, signals, fuel stations, buses, trucks, bikes, HUD) is original. Full inventory: docs/ASSETS.md.</li>
      </ul>
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
