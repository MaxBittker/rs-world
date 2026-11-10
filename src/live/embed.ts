// Embedded use (the swarm dashboard's map window).
// ?embed=1 hides the UI chrome (settings panel, live and info panels, minimap, fps) and frames the followed player
// from a higher, steeper orbit that suits a wide, short window.
// ?hideNames=a,b and ?hideNamesFrom=<url> (a JSON array of names, fetched with CORS) list players whose nameplates are
// never drawn. The URL form lets an embedding page hide a name without putting it in its own page.
// A follow target of MAIN_MARK means "the first hidden name".

const params = new URLSearchParams(window.location.search);

export const EMBED = params.get("embed") === "1";
export const MAIN_MARK = "⟦MAIN⟧";

// Embed camera: about 20 tiles out at roughly 50 degrees down, so the player and a few tiles around them fill
// a 2:1 frame without the horizon taking the top half.
export const EMBED_FOLLOW_DISTANCE = 20;
export const EMBED_FOLLOW_PITCH = -290;

const hidden = new Set<string>(
    (params.get("hideNames") ?? "")
        .split(",")
        .map((n) => n.trim().toLowerCase())
        .filter(Boolean),
);
let hiddenOrder: string[] = [...hidden];

const from = params.get("hideNamesFrom");
if (from) {
    fetch(from, { mode: "cors", cache: "no-store" })
        .then((r) => r.json())
        .then((list: unknown) => {
            if (!Array.isArray(list)) return;
            for (const n of list) if (typeof n === "string" && n) hidden.add(n.toLowerCase());
            hiddenOrder = [...hiddenOrder, ...list.filter((n): n is string => typeof n === "string" && !!n)];
        })
        .catch(() => {
            /* the dashboard is down: no extra hidden names */
        });
}

export function isNameHidden(name: string | undefined): boolean {
    return !!name && hidden.has(name.toLowerCase());
}

// Resolves the marker to the real name once the hidden list has loaded; undefined means "not yet".
export function resolveFollow(name: string): string | undefined {
    if (name !== MAIN_MARK) return name;
    return hiddenOrder[0];
}
