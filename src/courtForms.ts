export function districtCode(court: string): string | null {
    const match = court.match(/\b(\d{1,3}[AB]?)(?:st|nd|rd|th)?(?:\s*-\s*(\d))?\s+District Court\b/i);
    if (!match) return null;
    const division = match[2] || court.match(/\bDivision\s+(\d)\b/i)?.[1] || court.match(/\b(\d)(?:st|nd|rd|th)\s+Division\b/i)?.[1];
    return match[1].toUpperCase() + (division ? '-' + division : '');
}

export function resolveCourt(district: string, courts: string[]): string | null {
    const matches = [...new Set(courts.filter(court => districtCode(court) === district.toUpperCase()))];
    return matches.length === 1 ? matches[0] : null;
}

export function planFormImport(filename: string, courts: string[]): {role: 'advice' | 'local'; courtName: string} {
    if (/^(?:-\s*)?advice\.pdf$/i.test(filename)) return {role:'advice', courtName:''};
    if (/zoom/i.test(filename) || /^73A\s/i.test(filename)) {
        throw new Error('Awaiting Adam\'s instructions for this special packet. No automatic import.');
    }
    const code = filename.match(/^(\d{1,3}[AB]?(?:-\d)?)\s+Local\.pdf$/i)?.[1];
    if (!code) throw new Error('Court assignment needs manual confirmation. Use Save form with the exact court name.');
    const courtName = resolveCourt(code, courts);
    if (!courtName) throw new Error(`No unique verified MiFILE court name for ${code}. Assign the court manually.`);
    return {role:'local', courtName};
}
