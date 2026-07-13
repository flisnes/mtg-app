// First-run onboarding (beta plan §5): search → collect → trade in three
// sentences, then the account-is-optional callout and the iOS install hint
// that testers won't find otherwise.

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
            <strong>Import</strong> your collection from Moxfield, Archidekt, or a plain list, then build decks.
          </li>
          <li>
            <strong>Trade</strong> in person: one of you starts a trade, the other joins with the 6-character code.
          </li>
        </ol>

        <div className="onboard-account">
          <p className="onboard-account-head">
            No sign-up needed. The whole app works offline, and everything you add is stored on this device.
          </p>
          <p className="gate-note onboard-account-note">
            Creating an account is completely optional. If you do, you also get to:
          </p>
          <ul className="onboard-account-list">
            <li>Back up your collection to the server and restore it on another device.</li>
            <li>Share your tradelist &amp; wishlist so other users can find trades with you.</li>
            <li>Browse the community to spot matches with what others have and want.</li>
          </ul>
          <p className="gate-note onboard-account-note">
            You can create one any time from the <strong>account icon</strong> in the top-right corner.
          </p>
        </div>

        <p className="gate-note">
          On iPhone, tap Safari’s Share button then “Add to Home Screen” to install. Export a local backup from
          About now and then, too.
        </p>
        <button className="primary" onClick={onDone}>
          Get started
        </button>
      </div>
    </div>
  );
}
