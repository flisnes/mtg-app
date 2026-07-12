// First-run onboarding (beta plan §5): search → collect → trade in three
// sentences, plus the iOS install hint that testers won't find otherwise.

export function Onboarding({ onDone }: { onDone: () => void }) {
  return (
    <div className="gate">
      <div className="gate-inner">
        <div className="gate-logo" aria-hidden>
          ◆
        </div>
        <h1>MTG Collection &amp; Trade</h1>
        <ol className="onboard-steps">
          <li>
            <strong>Search</strong> any Magic card and add it to your collection, wishlist, or tradelist.
          </li>
          <li>
            <strong>Import</strong> your collection from Moxfield, Archidekt, or a plain list — then build decks.
          </li>
          <li>
            <strong>Trade</strong> in person: one of you starts a trade, the other joins with the 6-character code.
          </li>
        </ol>
        <p className="gate-note">
          On iPhone, tap Safari’s Share button then “Add to Home Screen” to install. Everything is stored on your
          device — export a backup from About now and then, or create an optional account under More to back up
          to the server.
        </p>
        <button className="primary" onClick={onDone}>
          Get started
        </button>
      </div>
    </div>
  );
}
