// Shape-matched loading placeholders — see app/globals.css for the .skel
// shimmer treatment shared with the desktop apps (shared-ui/kit.css).

export function SkeletonMenuRow() {
  return (
    <div className="bg-white rounded-2xl border border-black/10 shadow-tag p-4 flex items-center gap-3">
      <div className="skel w-14 h-14 rounded-xl shrink-0" />
      <div className="flex-1 min-w-0 grid gap-2">
        <div className="skel h-4 w-2/5 rounded" />
        <div className="skel h-3 w-1/4 rounded" />
        <div className="skel h-5 w-16 rounded mt-1" />
      </div>
      <div className="skel w-20 h-9 rounded-xl shrink-0" />
    </div>
  );
}

export function SkeletonOrderCard() {
  return (
    <div className="bg-white rounded-xl border p-4 grid gap-2">
      <div className="flex items-center justify-between">
        <div className="skel h-4 w-24 rounded" />
        <div className="skel h-5 w-28 rounded-full" />
      </div>
      <div className="skel h-3 w-3/5 rounded" />
      <div className="skel h-3 w-2/5 rounded" />
    </div>
  );
}

export function SkeletonList({ rows, render }: { rows: number; render: (i: number) => React.ReactNode }) {
  return <div className="grid gap-3">{Array.from({ length: rows }, (_, i) => <div key={i}>{render(i)}</div>)}</div>;
}
