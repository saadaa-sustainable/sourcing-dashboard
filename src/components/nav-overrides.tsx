'use client';

import { createContext, useContext } from 'react';

/**
 * Global sidebar tab-visibility overrides (path → visible), provided once by the root
 * layout (server-loaded) so the client SideNav can read them from context — this keeps the
 * server-only loader out of form-layout.tsx (which client components import for Field/Notice).
 */
const NavOverridesContext = createContext<Record<string, boolean>>({});

export function NavOverridesProvider({
  value,
  children,
}: {
  value: Record<string, boolean>;
  children: React.ReactNode;
}) {
  return <NavOverridesContext.Provider value={value}>{children}</NavOverridesContext.Provider>;
}

export function useNavOverrides(): Record<string, boolean> {
  return useContext(NavOverridesContext);
}
