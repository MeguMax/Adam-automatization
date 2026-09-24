export type FormRole = 'advice' | 'local';
export interface LibraryForm {
    id: string;
    role: FormRole;
    courtName: string;
    courtKey: string;
    filename: string;
    sha256: string;
    fileSize: number;
    active: number;
    createdAt: string;
}
export function courtKey(value: string): string {
    return value.trim().replace(/\s+/g, ' ').toLowerCase();
}
