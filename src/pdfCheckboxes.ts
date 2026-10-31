export interface CheckboxAnchor { text: string; x: number; y: number; width: number; height: number }
export type ComplaintSelectionKey = 'money' | 'rent' | 'damages' | 'noRelated' | 'previousRelated';
export type ComplaintSelections = Partial<Record<ComplaintSelectionKey, boolean>> & { conflicts?: ComplaintSelectionKey[] };

/** Missing observations cannot erase evidence; contradictory boxes cannot choose a winner. */
export function mergeComplaintSelections(observations: ComplaintSelections[]): ComplaintSelections {
    const result: ComplaintSelections = {};
    const conflicts = new Set(observations.flatMap(observation => observation.conflicts || []));
    for (const key of ['money', 'rent', 'damages', 'noRelated', 'previousRelated'] as const) {
        const values = new Set(observations.map(observation => observation[key]).filter(value => typeof value === 'boolean'));
        if (values.size > 1) conflicts.add(key);
        if (values.size === 1 && !conflicts.has(key)) result[key] = [...values][0];
    }
    if (conflicts.size) result.conflicts = [...conflicts];
    return result;
}

/** Read the interior only after finding all four sides of a real square next to its label. */
export function readCheckboxBeforeAnchor(pixels: Uint8ClampedArray, width: number, height: number,
    anchor: CheckboxAnchor): boolean | undefined {
    const sx = width / 612, sy = height / 792;
    const shade = (x: number, y: number) => {
        const px = Math.round(x * sx), py = Math.round(y * sy);
        if (px < 0 || py < 0 || px >= width || py >= height) return 255;
        const i = (py * width + px) * 4;
        return pixels[i + 3] > 100 ? (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3 : 255;
    };
    const dark = (x: number, y: number) => shade(x,y) < 175;
    let best: { score: number; x: number; y: number; side: number } | undefined;
    // Flattened SCAO forms include 8.75pt squares with thin, quarter-point borders.
    for (let side = 7; side <= 11; side += 0.25) {
        for (let x = anchor.x - 17; x <= anchor.x - side - 1; x += 0.25) {
            for (let y = anchor.y - 3; y <= anchor.y + 3; y += 0.25) {
                const edges = [0, 0, 0, 0];
                for (let n = 1; n <= 10; n++) {
                    const offset = side * (0.1 + n * 0.075);
                    edges[0] += Number(dark(x + offset, y));
                    edges[1] += Number(dark(x + offset, y + side));
                    edges[2] += Number(dark(x, y + offset));
                    edges[3] += Number(dark(x + side, y + offset));
                }
                const score = edges.reduce((sum, value) => sum + value, 0) / 40;
                if (Math.min(...edges) < 6 || score < 0.8 || (best && score <= best.score)) continue;
                best = {score, x, y, side};
            }
        }
    }
    if (!best) return;
    const interior: number[] = [];
    for (let x = best.x + 2; x <= best.x + best.side - 2; x += 0.3) {
        for (let y = best.y + 2; y <= best.y + best.side - 2; y += 0.3) {
            interior.push(shade(x,y));
        }
    }
    const density = interior.filter(value=>value<175).length / interior.length;
    // A scan's paper tone is not a mark. Require visible contrast against the local background.
    const background = [...interior].sort((a,b)=>a-b)[Math.floor(interior.length*0.9)];
    if (background < 210) return;
    if (density > 0.14) return true;
    const faintThreshold = Math.min(235,background-12);
    return density < 0.025 && interior.filter(value=>value<faintThreshold).length / interior.length < 0.025
        ? false : undefined;
}

export function readComplaintSelections(pixels: Uint8ClampedArray, width: number, height: number,
    words: CheckboxAnchor[]): ComplaintSelections {
    const observations: ComplaintSelections[] = [];
    const candidates = words.map(word => ({ ...word, text: words.filter(other => other.x >= word.x - 0.5 &&
        Math.abs(other.y - word.y) < 3).sort((a,b)=>a.x-b.x).map(other=>other.text).join(' ') }));
    const labels: Array<[ComplaintSelectionKey, RegExp]> = [
        ['money', /^10\.(?:\s|$)/], ['rent', /^Rent owing/i], ['damages', /^Damages claimed/i],
        ['noRelated', /^There is no other pending/i], ['previousRelated', /^A civil action between/i],
    ];
    for (const [key, pattern] of labels) {
        for (const anchor of candidates.filter(word => pattern.test(word.text))) {
            observations.push({ [key]: readCheckboxBeforeAnchor(pixels, width, height, anchor) });
        }
    }
    return mergeComplaintSelections(observations);
}
