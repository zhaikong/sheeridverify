// Primary IDs observed on the current Google One SheerID form; fallbacks support other layouts.
export const selectors = {
  firstName: ['#sid-first-name', 'input[name="firstName"]'],
  lastName: ['#sid-last-name', 'input[name="lastName"]'],
  email: ['#sid-email', 'input[name="email"]'],
  organization: ['#sid-college-name', '#sid-organization', 'input[name="organization"]'],
  birthMonth: ['#sid-birthdate__month', 'select[name="birthDateMonth"]', 'input[name="birthDateMonth"]'],
  birthDay: ['#sid-birthdate-day', '#sid-birthdate__day', 'input[name="birthDateDay"]', 'select[name="birthDateDay"]'],
  birthYear: ['#sid-birthdate-year', '#sid-birthdate__year', 'input[name="birthDateYear"]', 'select[name="birthDateYear"]'],
  country: ['#sid-country', 'select[name="country"]'],
  consent: ['#sid-consent', 'input[name="consent"]'],
  submit: ['#sid-submit-wrapper__collect-info', 'button[type="submit"]', '#sid-submit-btn'],
};
