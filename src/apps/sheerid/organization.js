// Observed SheerID behavior: selection replaces #sid-college-name with a readonly
// textbox named School/学校 and a neighboring Clear selection button.
export async function organizationIsSelected(page, { labels, timeoutMs }) {
  const selected = page.getByRole('textbox', { name: /^(?:学校|學校|School|College|University)$/i })
    .filter({ visible: true });
  if (await selected.count() !== 1) return false;
  const state = await selected.evaluate(element => ({
    readonly: element instanceof HTMLInputElement && element.readOnly,
    value: element instanceof HTMLInputElement ? element.value : '',
    invalid: element.getAttribute('aria-invalid') === 'true',
    busy: element.getAttribute('aria-busy') === 'true',
  }), undefined, { timeout: timeoutMs });
  if (!state.readonly || state.invalid || state.busy) return false;
  // Keep every school/campus word. Only normalize the separators that differ
  // between the search result's accessible name and the selected display.
  const normalize = value => value.trim().replace(/[\s,，]+/g, ' ').toLocaleLowerCase();
  return labels.some(label => label.trim() && normalize(label) === normalize(state.value));
}
