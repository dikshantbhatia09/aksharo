import { StylesView } from "./styles-view";

/**
 * The style catalogue, drawn by the real renderer.
 *
 * This used to mount `StyleGallery` — the right-panel dev harness, complete
 * with its JSON op log — as a signed-in page. That harness is a development
 * tool and still lives at `components/editor/panels/StyleGallery.tsx` for the
 * editor work; what a user reaches from the rail is the catalogue.
 */
export default function StylesPage(): React.JSX.Element {
  return <StylesView />;
}
