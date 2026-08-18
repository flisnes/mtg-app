import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons.js';

// The "Select" button that starts multi-select, in every list that has one.
//
// It lives in the list's toolbar, which scrolls away — and deciding you want to
// select things happens *while* scrolling, halfway down a collection, not before
// you start. So once the real button leaves the screen a copy of it floats above
// the tab bar, and tapping either one does the same thing. Nothing in the layout
// moves: the toolbar keeps its button, the floating one is a portal.
//
// Not a sticky toolbar on purpose — the toolbar carries the sort selects, the
// view toggle and a line of counts, and pinning all of that to the top costs
// real reading room on a phone.

export function SelectToggle({
  onEnter,
  label = 'Select',
  title = 'Select multiple cards',
}: {
  onEnter: () => void;
  label?: string;
  title?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [away, setAway] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // threshold 1: the copy appears as soon as the real button is even partly
    // cut off, rather than waiting for it to disappear completely.
    const io = new IntersectionObserver(([entry]) => setAway(!entry?.isIntersecting), { threshold: 1 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const body = (
    <>
      <Icon name="check" size={15} /> {label}
    </>
  );
  return (
    <>
      <button ref={ref} className="select-toggle" onClick={onEnter} title={title}>
        {body}
      </button>
      {away &&
        createPortal(
          <button className="select-toggle select-float" onClick={onEnter} title={title}>
            {body}
          </button>,
          document.body,
        )}
    </>
  );
}
