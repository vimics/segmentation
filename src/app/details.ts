/** The start-page form: validation and the case line shown at the top of the viewer. */

export type Species = 'Dog' | 'Cat';

export interface CaseDetails {
  name: string;
  species: Species;
  breed: string | null;
  ageMonths: number;
  weightKg: number;
  clinician: string | null;
}

export interface RawDetails {
  name: string;
  species: string;
  years: string;
  months: string;
  weight: string;
  breed: string;
  clinician: string;
}

export type FieldErrors = Partial<Record<'name' | 'species' | 'age' | 'weight', string>>;

const wholeNumber = (s: string) => (/^\d+$/.test(s) ? parseInt(s, 10) : NaN);

export function validateDetails(raw: RawDetails): { details?: CaseDetails; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const name = raw.name.trim();
  if (!name) errors.name = "Enter the patient's name.";
  if (raw.species !== 'Dog' && raw.species !== 'Cat') errors.species = 'Choose cat or dog.';

  const yearsText = raw.years.trim(), monthsText = raw.months.trim();
  const years = yearsText ? wholeNumber(yearsText) : 0;
  const months = monthsText ? wholeNumber(monthsText) : 0;
  if (!yearsText && !monthsText) errors.age = 'Enter the age.';
  else if (Number.isNaN(years) || Number.isNaN(months) || years > 40 || months > 11) errors.age = 'Enter years, and months from 0 to 11.';
  else if (years === 0 && months === 0) errors.age = 'Enter the age. For under a month, use 1 month.';

  // Turkish keyboards type a decimal comma.
  const weightKg = parseFloat(raw.weight.trim().replace(',', '.'));
  if (!raw.weight.trim()) errors.weight = 'Enter the weight in kg.';
  else if (!/^\d+([.,]\d+)?$/.test(raw.weight.trim()) || !(weightKg >= 0.05 && weightKg <= 200)) errors.weight = 'Enter a weight in kg, for example 12.4.';

  if (Object.keys(errors).length) return { errors };
  return {
    errors,
    details: {
      name,
      species: raw.species as Species,
      breed: raw.breed.trim() || null,
      ageMonths: years * 12 + months,
      weightKg,
      clinician: cleanClinician(raw.clinician),
    },
  };
}

/** The form adds ", DVM" itself, so a vet typing "Dr Jane Doe DVM" doesn't get it twice. */
export function cleanClinician(input: string): string | null {
  const name = input.trim().replace(/^(dr\.?|vet\.?\s*hek\.?)\s+/i, '').replace(/[,\s]*d\.?v\.?m\.?$/i, '').trim();
  return name || null;
}

export function formatAge(ageMonths: number): string {
  const y = Math.floor(ageMonths / 12), m = ageMonths % 12;
  if (y === 0) return `${m} mo`;
  return m ? `${y} y ${m} mo` : `${y} y`;
}

export function formatStudyDate(dicomDate: string | undefined, today = new Date()): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(dicomDate ?? '');
  if (m && +m[2] >= 1 && +m[2] <= 12) return `${+m[3]} ${months[+m[2] - 1]} ${m[1]}`;
  return `${today.getDate()} ${months[today.getMonth()]} ${today.getFullYear()}`;
}

/** Patient Name · Cat or Dog · Breed · Age · Weight kg · Name Surname, DVM · Date */
export function caseLine(d: CaseDetails, date: string): string {
  return [
    d.name,
    d.species,
    d.breed,
    formatAge(d.ageMonths),
    `${d.weightKg} kg`,
    d.clinician ? `${d.clinician}, DVM` : null,
    date,
  ].filter(Boolean).join(' · ');
}

const CANINE = /canine|dog|canis|köpek|kopek/i, FELINE = /feline|cat\b|felis|kedi/i;

/** Species recorded in the file, when it clearly disagrees with the form. */
export function speciesConflict(entered: Species, dicomSpecies: string): boolean {
  if (entered === 'Dog') return FELINE.test(dicomSpecies);
  return CANINE.test(dicomSpecies);
}
