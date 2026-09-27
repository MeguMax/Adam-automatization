export function districtCode(court: string): string | null {
    const match = court.match(/\b(\d{1,3}[AB]?)(?:st|nd|rd|th)?(?:\s*-\s*(\d))?\s+District Court\b/i);
    if (!match) return null;
    const division = match[2] || court.match(/\bDivision\s+(\d)\b/i)?.[1] || court.match(/\b(\d)(?:st|nd|rd|th)\s+Division\b/i)?.[1];
    return match[1].toUpperCase() + (division ? '-' + division : '');
}

export function resolveCourt(district: string, courts: string[]): string | null {
    const normalized = normalizeImportCode(district);
    const matches = [...new Set([...courts, ...(KNOWN_MIFILE_COURTS[normalized] || [])]
        .filter(court => districtCode(court) === normalized))];
    return matches.length === 1 ? matches[0] : null;
}

const KNOWN_MIFILE_COURTS: Record<string, string[]> = {
    '1': ['MI Monroe County - Monroe - 1st District Court'],
    '2A': ['MI Lenawee County - Adrian - 2A District Court'],
    '8': ['MI Kalamazoo County - North - 8th District Court'],
    '12': ['MI Jackson County - Jackson - 12th District Court'],
    '15': ['MI Washtenaw County - Ann Arbor - 15th District Court'],
    '16': ['MI Wayne County - Livonia - 16th District Court'],
    '17': ['MI Wayne County - Redford - 17th District Court'],
    '18': ['MI Wayne County - Westland - 18th District Court'],
    '19': ['MI Wayne County - Dearborn - 19th District Court'],
    '21': ['MI Wayne County - Garden City - 21st District Court'],
    '22': ['MI Wayne County - Inkster - 22nd District Court'],
    '23': ['MI Wayne County - Taylor - 23rd District Court'],
    '24': ['MI Wayne County - Allen Park - 24th District Court'],
    '25': ['MI Wayne County - Lincoln Park - 25th District Court'],
    '27': ['MI Wayne County - Wyandotte - 27th District Court'],
    '28': ['MI Wayne County - Southgate - 28th District Court'],
    '29': ['MI Wayne County - Wayne - 29th District Court'],
    '30': ['MI Wayne County - Highland Park - 30th District Court'],
    '31': ['MI Wayne County - Hamtramck - 31st District Court'],
    '32A': ['MI Wayne County - Harper Woods - 32A District Court'],
    '33': ['MI Wayne County - Woodhaven - 33rd District Court'],
    '34': ['MI Wayne County - Romulus - 34th District Court'],
    '35': ['MI Wayne County - Plymouth - 35th District Court'],
    '37': ['MI Macomb County - 37th District Court'],
    '38': ['MI Macomb County - Eastpointe - 38th District Court'],
    '40': ['MI Macomb County - St. Clair Shores - 40th District Court'],
    '41A-1': ['MI Macomb County - Sterling Heights - 41A-1 District Court'],
    '41A-2': ['MI Macomb County - Shelby Township - 41A-2 District Court'],
    '41B': ['MI Macomb County - Clinton Township - 41B District Court'],
    '42-1': ['MI Macomb County - Romeo - 42-1 District Court'],
    '42-2': ['MI Macomb County - New Baltimore - 42-2 District Court'],
    '43-2': ['MI Oakland County - Ferndale - 43-2 District Court'],
    '44': ['MI Oakland County - Royal Oak - 44th District Court'],
    '45': ['MI Oakland County - Oak Park - 45th District Court'],
    '46': ['MI Oakland County - Southfield - 46th District Court'],
    '47': ['MI Oakland County - Farmington Hills - 47th District Court'],
    '48': ['MI Oakland County - Bloomfield Hills - 48th District Court'],
    '50': ['MI Oakland County - Pontiac - 50th District Court'],
    '51': ['MI Oakland County - Waterford - 51st District Court'],
    '52-1': ['MI Oakland County - Novi - 52-1 District Court'],
    '52-2': ['MI Oakland County - Clarkston - 52-2 District Court'],
    '52-3': ['MI Oakland County - Rochester Hills - 52-3 District Court'],
    '52-4': ['MI Oakland County - Troy - 52-4 District Court'],
    '53': ['MI Livingston County - Howell - 53rd District Court'],
    '54A': ['MI Ingham County - Lansing - 54A District Court'],
    '55': ['MI Ingham County - Mason - 55th District Court'],
    '56A': ['MI Eaton County - Charlotte - 56A District Court'],
    '58H': ['MI Ottawa County - Holland - 58th District Court'],
    '65B': ['MI Gratiot County - Ithaca - 65B District Court'],
    '66': ['MI Shiawassee County - Corunna - 66th District Court'],
    '71A': ['MI Lapeer County - Lapeer - 71A District Court'],
    '72': ['MI Saint Clair County - Marine City - 72-1 District Court', 'MI Saint Clair County - Port Huron - 72-2 District Court'],
    '73A': ['MI Sanilac County - Sandusky - 73A District Court'],
    '75': ['MI Midland County - Midland - 75th District Court'],
    '90': ['MI Emmet County - Petoskey - 90-2 District Court'],
    '98': ['MI Gogebic County - Bessemer - 98-1 District Court', 'MI Ontonagon County - Ontonagon - 98-2 District Court'],
};

function normalizeImportCode(code: string): string {
    const upper = code.toUpperCase();
    if (upper === '41A1') return '41A-1';
    if (upper === '41A2') return '41A-2';
    if (upper === '43-F') return '43-2';
    return upper;
}

function courtsForImport(code: string, courts: string[]): string[] {
    const normalized = normalizeImportCode(code);
    const observed = courts.filter(court => districtCode(court) === normalized);
    return [...new Set([...observed, ...(KNOWN_MIFILE_COURTS[normalized] || [])])];
}

export interface FormImportPlan {
    role: 'advice' | 'local';
    courtName: string;
    slotKey: string;
    allowMixedTitles?: boolean;
}

export function planFormImports(filename: string, courts: string[]): FormImportPlan[] {
    if (/^(?:-\s*)?advice\.pdf$/i.test(filename)) return [{role:'advice', courtName:'', slotKey:'primary'}];
    const code = filename.match(/^(\d{1,3}[AB]?(?:-?\d)?|43-F|58H)\s+Local\.pdf$/i)?.[1];
    const zoomCode = filename.match(/^(\d{1,3}[AB]?(?:-\d)?)\s+Local\s+Zoom\.pdf$/i)?.[1];
    const resolvedCode = zoomCode || code;
    if (!resolvedCode) throw new Error('Court assignment needs manual confirmation. Use Save form with the exact court name.');
    const courtNames = courtsForImport(resolvedCode, courts);
    if (!courtNames.length) throw new Error(`No verified MiFILE court name for ${resolvedCode}. Assign the court manually.`);
    return courtNames.map(courtName => ({
        role:'local', courtName,
        slotKey: zoomCode ? 'zoom-instructions' : 'primary',
        allowMixedTitles: normalizeImportCode(resolvedCode) === '73A',
    }));
}

export function planFormImport(filename: string, courts: string[]): FormImportPlan {
    const plans = planFormImports(filename, courts);
    if (plans.length !== 1) throw new Error(`The form applies to ${plans.length} MiFILE courts. Use the batch importer.`);
    return plans[0];
}
