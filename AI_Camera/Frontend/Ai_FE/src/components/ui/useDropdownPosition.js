import { useLayoutEffect, useState } from "react";

// Shared by Select.jsx and UserSelect.jsx (both render their open panel
// via a document.body portal, positioned with `fixed` coordinates
// measured from the trigger's own bounding box — see either file's
// module comment for why: GlassCard's backdrop-filter creates a
// stacking context that traps an in-place absolutely-positioned panel).
// This hook is the one place that decides which SIDE of the trigger the
// panel opens on and how tall it's allowed to get, so the two
// components never duplicate that math.
//
// Rule: prefer opening downward if the panel's natural max height fits;
// otherwise open upward if THAT fits; otherwise open on whichever side
// has more room and shrink the panel's max-height to fit it exactly
// (the panel's own internal `overflow-y-auto` list then scrolls) — so
// the panel can never extend past the viewport, on mobile, in a modal,
// or anywhere else.
const PANEL_GAP = 8;
const PANEL_MAX_HEIGHT = 240; // matches the pre-existing max-h-60 (60 * 4px)

function computePlacement(rect) {
  const viewportHeight = window.innerHeight;
  const spaceBelow = Math.max(viewportHeight - rect.bottom - PANEL_GAP, 0);
  const spaceAbove = Math.max(rect.top - PANEL_GAP, 0);

  let openUpward;
  if (spaceBelow >= PANEL_MAX_HEIGHT) {
    openUpward = false; // full room below — always prefer down
  } else if (spaceAbove >= PANEL_MAX_HEIGHT) {
    openUpward = true; // not enough below, but full room above
  } else {
    openUpward = spaceAbove > spaceBelow; // neither fits fully — use the bigger side
  }

  const availableSpace = openUpward ? spaceAbove : spaceBelow;

  return {
    left: rect.left,
    width: rect.width,
    openUpward,
    maxHeight: Math.min(PANEL_MAX_HEIGHT, availableSpace),
    ...(openUpward ? { bottom: viewportHeight - rect.top + PANEL_GAP } : { top: rect.bottom + PANEL_GAP }),
  };
}

// `triggerRef` is a stable ref object (identity never changes across
// renders), so it's safe as an effect dependency without ever causing
// an extra run. useLayoutEffect (not useEffect) — measures/positions
// synchronously before the browser paints, so the panel never flashes
// at its old/default position for a frame when it opens or when the
// trigger moves (e.g. a page scroll mid-open).
export function useDropdownPosition(triggerRef, open) {
  const [panelRect, setPanelRect] = useState(null);

  useLayoutEffect(() => {
    if (!open) return;

    const updatePanelRect = () => {
      if (!triggerRef.current) return;
      setPanelRect(computePlacement(triggerRef.current.getBoundingClientRect()));
    };

    updatePanelRect();

    // capture: true — scroll events don't bubble, so a scroll on any
    // scrollable ancestor (not just window, e.g. a Modal's own internal
    // overflow-y-auto body) is only observable this way.
    window.addEventListener("scroll", updatePanelRect, true);
    window.addEventListener("resize", updatePanelRect);

    return () => {
      window.removeEventListener("scroll", updatePanelRect, true);
      window.removeEventListener("resize", updatePanelRect);
    };
  }, [open, triggerRef]);

  return panelRect;
}
