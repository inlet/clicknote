// The line that hands a send to the agent as a prompt, in the user's own voice: a wait prints it,
// and a copy gives it for the clipboard. `file` is the full path of annotations.md, written as the
// bridge's system writes it; a path with a space goes in double quotes, so the agent reads it as
// one path.
export function sendLine(count: number, url: string, file: string): string {
  const path = file.includes(' ') ? `"${file}"` : file;
  return `Browser annotations (${count}) on ${url}: read ${path}, `
    + 'carry out the Change items and answer the Question items.';
}
