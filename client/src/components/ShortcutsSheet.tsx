import { Sheet } from './Sheet.js';

// The list of what the keyboard can do, because otherwise nobody finds out.
//
// Every shortcut in the app is invisible: there is no menu that names them and
// no hint on the page. `?` opens this, and this is the one place they're
// written down, so a key added anywhere belongs in the matching group here too.
//
// Phone-first app, so all of this is desktop-only by nature: none of it can be
// pressed on a touchscreen, and the card keys need a pointer to point with.

interface Group {
  title: string;
  note?: string;
  keys: { press: string[]; does: string }[];
}

const GROUPS: Group[] = [
  {
    title: 'Anywhere',
    keys: [
      { press: ['Ctrl', 'K'], does: 'Jump to the search box' },
      { press: ['/'], does: 'Same, one key' },
      { press: ['V'], does: 'Switch between list and grid' },
      { press: ['?'], does: 'This list' },
      { press: ['Esc'], does: 'Close whatever is on top' },
    ],
  },
  {
    title: 'Undo',
    note: 'Only reaches changes you made on the page you are looking at, this session.',
    keys: [
      { press: ['Ctrl', 'Z'], does: 'Undo your last change here' },
      { press: ['Ctrl', 'Y'], does: 'Redo it' },
    ],
  },
  {
    title: 'The card you are pointing at',
    note: 'In a deck, binder or box. Point with the mouse or walk there with the arrow keys.',
    keys: [
      { press: ['+'], does: 'One more copy' },
      { press: ['−'], does: 'One fewer, and out of the list at zero' },
      { press: ['Enter'], does: 'Open the card' },
      { press: ['Del'], does: 'Take it out' },
      { press: ['X'], does: 'Tick it for a bulk action' },
      { press: ['←', '→', '↑', '↓'], does: 'Move to another card' },
      { press: ['Esc'], does: 'Stop pointing at anything' },
    ],
  },
  {
    title: 'Cards on the clipboard',
    note: 'Copies out as an ordinary decklist, and back in as the exact printings.',
    keys: [
      { press: ['Ctrl', 'A'], does: 'Select every card on the page' },
      { press: ['Ctrl', 'C'], does: 'Copy the selection, or the whole thing' },
      { press: ['Ctrl', 'X'], does: 'Cut, moved when you paste' },
      { press: ['Ctrl', 'V'], does: 'Paste cards, or import a list from anywhere' },
    ],
  },
  {
    title: 'Search results',
    keys: [{ press: ['+'], does: 'Add the card you are pointing at' }],
  },
];

export function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet onClose={onClose} title="Keyboard shortcuts" className="shortcuts-sheet">
      <p className="fine-print">On a keyboard, deck building goes a lot faster.</p>
      {GROUPS.map((g) => (
        <div key={g.title} className="shortcut-group">
          <h3 className="card-group-title">{g.title}</h3>
          {g.note && <p className="fine-print">{g.note}</p>}
          <ul className="shortcut-list">
            {g.keys.map((k) => (
              <li key={k.does}>
                <span className="shortcut-keys">
                  {k.press.map((p) => (
                    <kbd key={p}>{p}</kbd>
                  ))}
                </span>
                <span className="shortcut-does">{k.does}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="sheet-actions">
        <button onClick={onClose}>Close</button>
      </div>
    </Sheet>
  );
}
