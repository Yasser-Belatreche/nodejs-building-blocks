export interface Persistence {
    connect(): Promise<void>;

    disconnect(): Promise<void>;

    transaction<T>(func: () => Promise<T>): Promise<T>;

    clear(): Promise<void>;

    backup(): Promise<void>;

    restore(): Promise<void>;

    health(): Promise<PersistenceHealth>;
}

export interface PersistenceHealth {
    provider: string;
    status: 'up' | 'down';
    message?: string;
}
