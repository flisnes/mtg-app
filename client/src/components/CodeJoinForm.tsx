import { useState, type ReactNode } from 'react';
import { CODE_LENGTH } from '@mtg/shared';

/**
 * Session-code entry (trade join, device transfer) as a real form, so Enter
 * submits just like tapping the button. Typed or pasted input is uppercased
 * and stripped of anything that can't be part of a code (spaces, punctuation).
 */
export function CodeJoinForm({
  label,
  submitLabel,
  primary = false,
  autoFocus = false,
  onSubmit,
  children,
}: {
  /** Accessible name for the input, e.g. "Join code". */
  label: string;
  submitLabel: string;
  primary?: boolean;
  autoFocus?: boolean;
  onSubmit: (code: string) => void;
  /** Extra buttons after the submit button (must use type="button"). */
  children?: ReactNode;
}) {
  const [code, setCode] = useState('');
  const ready = code.length === CODE_LENGTH;
  return (
    <form
      className="list-toolbar"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onSubmit(code);
      }}
    >
      <input
        className="search-input grow"
        placeholder="Enter code…"
        value={code}
        // No maxLength: it would clip a pasted "ABC 123" before the sanitizer
        // strips the space. Clamp after cleaning instead.
        onChange={(e) =>
          setCode(
            e.target.value
              .toUpperCase()
              .replace(/[^A-Z0-9]/g, '')
              .slice(0, CODE_LENGTH),
          )
        }
        autoFocus={autoFocus}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        enterKeyHint="go"
        aria-label={label}
      />
      <button type="submit" className={primary ? 'primary' : undefined} disabled={!ready}>
        {submitLabel}
      </button>
      {children}
    </form>
  );
}
