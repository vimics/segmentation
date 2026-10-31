import { describe, expect, it } from 'vitest';
import { caseLine, cleanClinician, formatAge, formatStudyDate, speciesConflict, validateDetails, type RawDetails } from '../src/app/details';

const valid: RawDetails = { name: 'Max', species: 'Dog', years: '3', months: '2', weight: '12.4', breed: '', clinician: '' };

describe('start form', () => {
  it('requires name, species, age and weight', () => {
    const { errors, details } = validateDetails({ name: ' ', species: '', years: '', months: '', weight: '', breed: '', clinician: '' });
    expect(details).toBeUndefined();
    expect(Object.keys(errors).sort()).toEqual(['age', 'name', 'species', 'weight']);
  });

  it('leaves breed and clinician optional', () => {
    const { details } = validateDetails(valid);
    expect(details).toEqual({ name: 'Max', species: 'Dog', breed: null, ageMonths: 38, weightKg: 12.4, clinician: null });
  });

  it('accepts a decimal comma and months alone', () => {
    expect(validateDetails({ ...valid, weight: '4,5' }).details?.weightKg).toBe(4.5);
    expect(validateDetails({ ...valid, years: '', months: '8' }).details?.ageMonths).toBe(8);
  });

  it.each([['abc'], ['-3'], ['0'], ['500'], ['1.2.3']])('rejects weight %s', (weight) => {
    expect(validateDetails({ ...valid, weight }).errors.weight).toBeTruthy();
  });

  it.each([['x', ''], ['99', ''], ['1', '12'], ['0', '0']])('rejects age %s y %s mo', (years, months) => {
    expect(validateDetails({ ...valid, years, months }).errors.age).toBeTruthy();
  });

  it('does not double up the DVM suffix', () => {
    expect(cleanClinician('Jane Doe')).toBe('Jane Doe');
    expect(cleanClinician('Jane Doe, DVM')).toBe('Jane Doe');
    expect(cleanClinician('Dr. Jane Doe DVM')).toBe('Jane Doe');
    expect(cleanClinician('   ')).toBeNull();
  });
});

describe('case line', () => {
  it('follows the agreed order with everything filled in', () => {
    const line = caseLine({ name: 'Max', species: 'Dog', breed: 'Beagle', ageMonths: 38, weightKg: 12.4, clinician: 'Jane Doe' }, '12 Oct 2026');
    expect(line).toBe('Max · Dog · Beagle · 3 y 2 mo · 12.4 kg · Jane Doe, DVM · 12 Oct 2026');
  });

  it('skips breed and clinician when empty', () => {
    const line = caseLine({ name: 'Luna', species: 'Cat', breed: null, ageMonths: 8, weightKg: 3, clinician: null }, '1 Jan 2026');
    expect(line).toBe('Luna · Cat · 8 mo · 3 kg · 1 Jan 2026');
  });

  it('formats ages and dates', () => {
    expect(formatAge(24)).toBe('2 y');
    expect(formatAge(11)).toBe('11 mo');
    expect(formatStudyDate('20261012')).toBe('12 Oct 2026');
    expect(formatStudyDate('', new Date(2026, 9, 31))).toBe('31 Oct 2026');
    expect(formatStudyDate('garbage', new Date(2026, 0, 2))).toBe('2 Jan 2026');
  });

  it('flags only a clear species conflict', () => {
    expect(speciesConflict('Dog', 'Feline')).toBe(true);
    expect(speciesConflict('Cat', 'Canine')).toBe(true);
    expect(speciesConflict('Dog', 'Canine')).toBe(false);
    expect(speciesConflict('Dog', '')).toBe(false);
  });
});
