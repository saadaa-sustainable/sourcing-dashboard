# Two small edits to existing files

## 1. `src/app/layout.tsx` — import the workflow styles

```diff
  import './globals.css';
+ import './workflows.css';
```

## 2. `src/components/dashboard-shell.tsx` — add workflow links to the sidebar

Find the `<nav>` block (~line 2532) and add a second group **after** the
existing `.map(...)`, just before `</nav>`:

```tsx
          <div className="wf-nav-divider">Workflows</div>
          <a href="/buying-plan"><ShoppingCart size={18} /><span>Buying Plan</span></a>
          <a href="/vendor-capacity"><Factory size={18} /><span>Vendor Capacity</span></a>
          <a href="/discontinue"><Ban size={18} /><span>Discontinue</span></a>
          <a href="/approvals"><ClipboardCheck size={18} /><span>Approvals</span></a>
```

Add to the lucide-react import at the top of the file:

```diff
- import { ..., Factory, ... } from "lucide-react";
+ import { ..., Factory, ShoppingCart, Ban, ClipboardCheck, ... } from "lucide-react";
```

`Factory` is already imported — don't duplicate it.

## 3. Optional: swap the TNA high-risk rule

`src/lib/business-logic.ts` line 38 `isHighRiskPo` uses EDD proximity, which is
not the rule Mahesh described. `src/lib/tna.ts` has the correct one. Where the
dashboard currently calls `isHighRiskPo`, call `tnaCriticalPath(tna).highRisk`
instead — it needs the TNA record, which `TrackerRow.tna` already carries.

Leave `isHighRiskPo` in place until you've compared the two side by side.
