const empty = (value: unknown) => value === null || value === undefined || value === '';
const equal = (left: unknown, right: unknown) => empty(left) && empty(right) || JSON.stringify(left) === JSON.stringify(right);

export function changedFieldPaths(path: string, before: any, after: any): string[] {
    if (equal(before, after)) return [];
    if (empty(before) && after && typeof after === 'object' && !Array.isArray(after)) {
        return Object.keys(after).flatMap(key=>changedFieldPaths(path+'.'+key,undefined,after[key]));
    }
    if (Array.isArray(before) && Array.isArray(after)) {
        if (before.length !== after.length || before.some((value, index) => value?.id !== after[index]?.id)) return [path];
        return after.flatMap((value, index) => changedFieldPaths(path + '.' + index, before[index], value));
    }
    if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
        return [...new Set([...Object.keys(before), ...Object.keys(after)])]
            .flatMap(key => changedFieldPaths(path + '.' + key, before[key], after[key]));
    }
    return [path];
}

export function protectedFieldPaths(root: Record<string, any>, legacyGroups: Iterable<string>): Set<string> {
    return new Set(Array.isArray(root.manualFilingPaths) ? root.manualFilingPaths.filter((path: unknown) =>
        typeof path === 'string' && /^[a-zA-Z0-9_.]+$/.test(path)) : legacyGroups);
}

export function mergeExtractedField<T>(path: string, before: T, extracted: T, protectedPaths: Set<string>): T {
    if (protectedPaths.has(path)) return before;
    if (![...protectedPaths].some(value => value.startsWith(path + '.'))) return extracted;
    if (Array.isArray(before) && Array.isArray(extracted)) {
        // Structural changes to party lists require review rather than moving a manual address to another person.
        if (before.length !== extracted.length) return before;
        return extracted.map((value, index) => mergeExtractedField(path + '.' + index, before[index], value, protectedPaths)) as T;
    }
    if (Array.isArray(before) && !extracted) return before.map((value, index) =>
        mergeExtractedField(path + '.' + index, value, undefined, protectedPaths)) as T;
    if (before && typeof before === 'object' && (!extracted || typeof extracted === 'object')) {
        return Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(extracted || {})])].map(key => [key,
            mergeExtractedField(path + '.' + key, (before as any)[key], (extracted as any)?.[key], protectedPaths),
        ])) as T;
    }
    return before;
}
