// The key hint on the popup's Add button, for navigator.platform: ⌘↵ on a Mac, iPhone or
// iPad, and Ctrl+↵ on Windows, Linux and any other system. The key works with both.
export function addHint(platform: string): string {
  return /^(Mac|iPhone|iPad)/.test(platform) ? '⌘↵' : 'Ctrl+↵';
}
