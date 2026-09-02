import { Suspense } from "react";

import { HomeView } from "./home-view";

/**
 * The real path is "/", reached only through `middleware.ts`'s rewrite for a
 * signed-in visitor — see that file and `home-view.tsx` for why this route is
 * not itself the one anyone links to.
 */
export default function HomePage(): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <HomeView />
    </Suspense>
  );
}
