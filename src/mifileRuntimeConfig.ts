import { getMiFileCredentials } from './mifileAccountSettings';

export type MiFileAccountEnvironment = 'test' | 'production';

export interface MiFileRuntimeConfig {
    accountEnvironment: MiFileAccountEnvironment;
    accountLabel: string;
    preparationMode: 'unsubmitted_only';
    credentialsConfigured: boolean;
    productionConfirmed: boolean;
    ready: boolean;
    issues: string[];
}

function enabled(value: string | undefined): boolean {
    return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

export function getMiFileRuntimeConfig(
    environment: NodeJS.ProcessEnv = process.env,
): MiFileRuntimeConfig {
    let credentialError: string | null = null;
    if (environment === process.env) {
        try {
            const credentials = getMiFileCredentials();
            if (credentials.source === 'admin') environment = {
                ...environment,
                MIFILE_USER: credentials.username,
                MIFILE_PASSWORD: credentials.password,
                MIFILE_ACCOUNT_ENVIRONMENT: credentials.accountEnvironment,
                MIFILE_ACCOUNT_LABEL: credentials.accountLabel,
                MIFILE_EXPECTED_ACCOUNT_EMAIL: credentials.username,
                MIFILE_PRODUCTION_ACCOUNT_CONFIRMED: String(credentials.productionConfirmed),
            };
        } catch (error) {
            credentialError = (error as Error).message;
        }
    }
    const rawEnvironment = String(environment.MIFILE_ACCOUNT_ENVIRONMENT || 'test')
        .trim()
        .toLowerCase();
    const accountEnvironment: MiFileAccountEnvironment = rawEnvironment === 'production'
        ? 'production'
        : 'test';
    const issues: string[] = [];
    if (credentialError) issues.push(credentialError);

    if (!['test', 'production'].includes(rawEnvironment)) {
        issues.push('MIFILE_ACCOUNT_ENVIRONMENT must be test or production.');
    }

    const username = String(environment.MIFILE_USER || '').trim();
    const password = String(environment.MIFILE_PASSWORD || '');
    const credentialsConfigured = Boolean(username && password);
    if (!credentialsConfigured) {
        issues.push('MiFILE username and password are not configured.');
    }

    const expectedUsername = String(environment.MIFILE_EXPECTED_ACCOUNT_EMAIL || '')
        .trim()
        .toLowerCase();
    if (expectedUsername && username.toLowerCase() !== expectedUsername) {
        issues.push('The configured MiFILE username does not match the expected account.');
    }

    const productionConfirmed = accountEnvironment !== 'production' ||
        enabled(environment.MIFILE_PRODUCTION_ACCOUNT_CONFIRMED);
    if (!productionConfirmed) {
        issues.push(
            'The production MiFILE account must be explicitly confirmed before preparation is enabled.',
        );
    }

    return {
        accountEnvironment,
        accountLabel: String(environment.MIFILE_ACCOUNT_LABEL || '').trim() ||
            (accountEnvironment === 'production' ? 'Production account' : 'Alternate account (live MiFILE)'),
        preparationMode: 'unsubmitted_only',
        credentialsConfigured,
        productionConfirmed,
        ready: issues.length === 0,
        issues,
    };
}
