import EventEmitter from 'node:events';

import { SessionCorrelationId } from '@lib/primitives/application-specific/session';

import { FailedEventsRepository } from './data-access/failed-events-repository';
import {
    Event,
    EventHandler,
    EventsBroker,
    EventsBrokerHealth,
    UniversalEventHandler,
} from '../events-broker';

class NodeNativeEventsBroker implements EventsBroker {
    private readonly eventsEmitter = new EventEmitter();

    private readonly UNIVERSAL_EVENT_NAME = '___UNIVERSAL___';
    private readonly eventHandlers = new Map<string, Array<EventHandler<Event<any>>>>();

    private static _instance: NodeNativeEventsBroker;

    static Instance(failedEventsRepository: FailedEventsRepository): NodeNativeEventsBroker {
        if (this._instance) return this._instance;

        this._instance = new NodeNativeEventsBroker(failedEventsRepository);

        return this._instance;
    }

    private constructor(private readonly failedEventsRepository: FailedEventsRepository) {}

    async publish<T extends Event<any>>(event: T, session: SessionCorrelationId): Promise<void> {
        this.eventsEmitter.emit(this.UNIVERSAL_EVENT_NAME, event, session);
        this.eventsEmitter.emit(event.name, event, session);
    }

    async registerEventHandler<T extends Event<any>>(handler: EventHandler<T>): Promise<void> {
        if (handler.config().disabled) return;

        this.eventsEmitter.on(handler.eventName(), (event: T, session: SessionCorrelationId) => {
            handler.handle(event, session).catch(async e => {
                await this.failedEventsRepository.save({
                    id: crypto.randomUUID(),
                    event,
                    eventOccuredAt: event.occurredAt,
                    handlerId: handler.id(),
                    handlerMaxRetries: handler.config().retries ?? 0,
                    sessionCorrelationId: session.correlationId,

                    retries: 0,
                    lastError: e as Error,
                    lastProcessingTryDate: new Date(),
                    processedSuccessfully: false,
                });
            });
        });

        if (!this.eventHandlers.has(handler.eventName())) {
            this.eventHandlers.set(handler.eventName(), []);
        }

        this.eventHandlers.get(handler.eventName())?.push(handler);
    }

    async registerUniversalEventHandler(handler: UniversalEventHandler): Promise<void> {
        if (handler.config().disabled) return;

        this.eventsEmitter.on(
            this.UNIVERSAL_EVENT_NAME,
            (event: Event<any>, session: SessionCorrelationId) => {
                handler.handle(event, session).catch(async e => {
                    await this.failedEventsRepository.save({
                        id: crypto.randomUUID(),
                        event,
                        eventOccuredAt: event.occurredAt,
                        handlerId: handler.id(),
                        handlerMaxRetries: handler.config().retries ?? 0,
                        sessionCorrelationId: session.correlationId,

                        retries: 0,
                        lastError: e as Error,
                        lastProcessingTryDate: new Date(),
                        processedSuccessfully: false,
                    });
                });
            },
        );

        if (!this.eventHandlers.has(this.UNIVERSAL_EVENT_NAME)) {
            this.eventHandlers.set(this.UNIVERSAL_EVENT_NAME, []);
        }

        this.eventHandlers.get(this.UNIVERSAL_EVENT_NAME)?.push(handler);
    }

    shouldExplicitlyRetryFailedEvents(): boolean {
        return true;
    }

    async retryFailedEvents(): Promise<void> {
        const list = await this.failedEventsRepository.findAllUnsuccessfullWithRetriesLessThanMax();

        for (const failed of list) {
            const handler =
                this.eventHandlers
                    .get(failed.event.name)
                    ?.find(h => h.idEquals(failed.handlerId)) ??
                this.eventHandlers
                    .get(this.UNIVERSAL_EVENT_NAME)
                    ?.find(h => h.idEquals(failed.handlerId));

            if (!handler) continue;

            failed.lastProcessingTryDate = new Date();
            failed.retries++;

            try {
                await handler.handle(failed.event, { correlationId: failed.sessionCorrelationId });

                failed.processedSuccessfully = true;
            } catch (e) {
                failed.lastError = e as Error;
            }

            await this.failedEventsRepository.save(failed);
        }
    }

    async clear(): Promise<void> {
        this.eventsEmitter.removeAllListeners();
        this.eventHandlers.clear();
    }

    async health(): Promise<EventsBrokerHealth> {
        return { provider: 'node-events-module', status: 'up' };
    }
}

export { NodeNativeEventsBroker };
