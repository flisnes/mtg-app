import { Suspense, lazy, type ComponentProps, type ComponentType } from 'react';
import type { PriceChartSheet as PriceChartSheetT } from './PriceChart.js';
import type { CardHistorySheet as CardHistorySheetT } from './CardHistory.js';
import type {
  CollectionValueChartSheet as CollectionValueChartSheetT,
  ContainerValueChartSheet as ContainerValueChartSheetT,
} from './CollectionValueChart.js';
import type { SealedValueChartSheet as SealedValueChartSheetT } from '../sealed/SealedValueChart.js';

// The chart sheets (and the plot code they share in ValueLineChart) only mount
// when someone taps a price or value. Lazy keeps them out of the boot chunk;
// the type-only imports above are erased at build time. Call sites import the
// sheets from here. Own Suspense per sheet: the route-level one in App.tsx
// would blank the whole page while the chunk arrives.
function lazySheet<C extends ComponentType<any>>(load: () => Promise<C>) {
  const Inner = lazy(() => load().then((c) => ({ default: c })));
  return function LazySheet(props: ComponentProps<C>) {
    return (
      <Suspense fallback={null}>
        <Inner {...props} />
      </Suspense>
    );
  };
}

export const PriceChartSheet = lazySheet<typeof PriceChartSheetT>(() =>
  import('./PriceChart.js').then((m) => m.PriceChartSheet),
);
export const CardHistorySheet = lazySheet<typeof CardHistorySheetT>(() =>
  import('./CardHistory.js').then((m) => m.CardHistorySheet),
);
export const CollectionValueChartSheet = lazySheet<typeof CollectionValueChartSheetT>(() =>
  import('./CollectionValueChart.js').then((m) => m.CollectionValueChartSheet),
);
export const ContainerValueChartSheet = lazySheet<typeof ContainerValueChartSheetT>(() =>
  import('./CollectionValueChart.js').then((m) => m.ContainerValueChartSheet),
);
export const SealedValueChartSheet = lazySheet<typeof SealedValueChartSheetT>(() =>
  import('../sealed/SealedValueChart.js').then((m) => m.SealedValueChartSheet),
);
