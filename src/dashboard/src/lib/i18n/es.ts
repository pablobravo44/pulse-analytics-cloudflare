// All Spanish dictionaries, keyed by the English source text (one file per area so they can be edited in parallel).
import { ES_ADMIN } from "./es-admin.ts";
import { ES_CORE } from "./es-core.ts";
import { ES_PAGES } from "./es-pages.ts";
import { ES_VIEWS } from "./es-views.ts";

export const ES: Record<string, string> = { ...ES_CORE, ...ES_VIEWS, ...ES_PAGES, ...ES_ADMIN };
