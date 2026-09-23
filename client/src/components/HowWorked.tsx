import type { ReactNode } from 'react';

// The rest of a section's small print (rebuild plan A6). Each section keeps the
// one caveat that changes how you read its number in view; the design log that
// defends the model lives in here, one tap away, for whoever wants it.

export function HowWorked({ children, label = 'How this is worked out' }: { children: ReactNode; label?: string }) {
  return (
    <details className="how-worked">
      <summary>{label}</summary>
      <div className="how-worked-body">{children}</div>
    </details>
  );
}
