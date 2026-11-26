/**
 * Formatting helpers shared by the dock panel and the confirm dialog.
 *
 * Own module so the dialog can print the same "last sync" stamp as the dock without importing
 * `dockPanel` (which would pull the store, the result panel and the import panel into the dialog).
 */

/**
 * `MM-DD HH:mm` in the user's local time zone.
 *
 * The stored stamp is ISO 8601 **UTC**; slicing the string (as history used to do) shows UTC and
 * silently disagrees with the clock in the menu bar. Anything unparsable falls back to the raw
 * value so a bad record cannot blank the line.
 */
export function stamp(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return iso.slice(0, 16).replace("T", " ");
    }
    const pad = (value: number): string => String(value).padStart(2, "0");
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
