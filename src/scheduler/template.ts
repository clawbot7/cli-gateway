export function renderTemplate(template: string): string {
  const now = new Date();
  return template
    .replaceAll('{{now_iso}}', now.toISOString())
    .replaceAll('{{date}}', now.toISOString().slice(0, 10));
}
