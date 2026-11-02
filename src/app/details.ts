/** The start-page form: validation and the case line shown at the top of the viewer. */

export type Species = 'Dog' | 'Cat';

export interface CaseDetails {
  name: string;
  species: Species;
  breed: string | null;
  ageYears: number;
  weightKg: number;
  clinician: string | null;
}

export interface RawDetails {
  name: string;
  species: string;
  age: string;
  weight: string;
  breed: string;
  clinician: string;
}

export type FieldErrors = Partial<Record<'name' | 'species' | 'age' | 'weight', string>>;

/** A positive number such as 3, 0.5 or 2,5. Turkish keyboards type a decimal comma. */
const decimal = (s: string) => (/^\d+([.,]\d+)?$/.test(s) ? parseFloat(s.replace(',', '.')) : NaN);

export function validateDetails(raw: RawDetails): { details?: CaseDetails; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const name = raw.name.trim();
  if (!name) errors.name = "Enter the patient's name.";
  if (raw.species !== 'Dog' && raw.species !== 'Cat') errors.species = 'Choose cat or dog.';

  const ageYears = decimal(raw.age.trim());
  if (!raw.age.trim()) errors.age = 'Enter the age in years.';
  else if (!(ageYears > 0 && ageYears <= 40)) errors.age = 'Enter the age in years, for example 3 or 0.5.';

  const weightKg = decimal(raw.weight.trim());
  if (!raw.weight.trim()) errors.weight = 'Enter the weight in kg.';
  else if (!(weightKg >= 0.05 && weightKg <= 200)) errors.weight = 'Enter a weight in kg, for example 12.4.';

  if (Object.keys(errors).length) return { errors };
  return {
    errors,
    details: {
      name,
      species: raw.species as Species,
      breed: raw.breed.trim() || null,
      ageYears,
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

export function formatAge(ageYears: number): string {
  return `${ageYears} y`;
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
    formatAge(d.ageYears),
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
