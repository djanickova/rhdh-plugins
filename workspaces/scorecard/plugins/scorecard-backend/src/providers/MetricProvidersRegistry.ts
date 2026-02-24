/*
 * Copyright Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { ConflictError, NotFoundError } from '@backstage/errors';
import {
  Metric,
  MetricValue,
} from '@red-hat-developer-hub/backstage-plugin-scorecard-common';
import type { Entity } from '@backstage/catalog-model';
import { MetricProvider } from '@red-hat-developer-hub/backstage-plugin-scorecard-node';

/**
 * Registry of all registered metric providers.
 */
export class MetricProvidersRegistry {
  private readonly metricProviders = new Map<string, MetricProvider>();
  private readonly datasourceIndex = new Map<string, Set<string>>();

  register(metricProvider: MetricProvider): void {
    const providerDatasource = metricProvider.getProviderDatasourceId();
    const metricType = metricProvider.getMetricType();

    // Support both single and batch providers
    const metricIds = metricProvider.getMetricIds?.() ?? [
      metricProvider.getProviderId(),
    ];
    const metrics = metricProvider.getMetrics?.() ?? [
      metricProvider.getMetric(),
    ];

    // Validate: Each metric ID must have a corresponding metric definition
    for (const metricId of metricIds) {
      const metric = metrics.find(m => m.id === metricId);
      if (!metric) {
        throw new Error(
          `Invalid metric provider: metric ID '${metricId}' returned by getMetricIds() ` +
            `does not have a corresponding metric in getMetrics()`,
        );
      }

      if (metricType !== metric.type) {
        throw new Error(
          `Invalid metric provider with ID ${metricId}, getMetricType() must match ` +
            `getMetric().type. Expected '${metricType}', but got '${metric.type}'`,
        );
      }

      // Validate: Provider ID format (datasource.metric_name)
      const expectedPrefix = `${providerDatasource}.`;
      if (!metricId.startsWith(expectedPrefix) || metricId === expectedPrefix) {
        throw new Error(
          `Invalid metric provider with ID ${metricId}, must have format ` +
            `'${providerDatasource}.<metric_name>' where metric name is not empty`,
        );
      }

      if (this.metricProviders.has(metricId)) {
        throw new ConflictError(
          `Metric provider with ID '${metricId}' has already been registered`,
        );
      }

      this.metricProviders.set(metricId, metricProvider);

      // Index by datasource
      let datasourceProviders = this.datasourceIndex.get(providerDatasource);
      if (!datasourceProviders) {
        datasourceProviders = new Set();
        this.datasourceIndex.set(providerDatasource, datasourceProviders);
      }
      datasourceProviders.add(metricId);
    }
  }

  getProvider(providerId: string): MetricProvider {
    const metricProvider = this.metricProviders.get(providerId);
    if (!metricProvider) {
      throw new NotFoundError(
        `Metric provider with ID '${providerId}' is not registered.`,
      );
    }
    return metricProvider;
  }

  getMetric(providerId: string): Metric {
    const provider = this.getProvider(providerId);

    // For batch providers, find the specific metric by ID
    if (provider.getMetrics) {
      const metrics = provider.getMetrics();
      const metric = metrics.find(m => m.id === providerId);
      if (metric) {
        return metric;
      }
    }

    return provider.getMetric();
  }

  async calculateMetric(
    providerId: string,
    entity: Entity,
  ): Promise<MetricValue> {
    return this.getProvider(providerId).calculateMetric(entity);
  }

  async calculateMetrics(
    providerIds: string[],
    entity: Entity,
  ): Promise<{ providerId: string; value?: MetricValue; error?: Error }[]> {
    const results = await Promise.allSettled(
      providerIds.map(providerId => this.calculateMetric(providerId, entity)),
    );

    return results.map((result, index) => {
      const providerId = providerIds[index];
      if (result.status === 'fulfilled') {
        return { providerId, value: result.value };
      }
      return { providerId, error: result.reason as Error };
    });
  }

  listProviders(): MetricProvider[] {
    // Deduplicate providers since batch providers are stored under multiple metric IDs
    return [...new Set(this.metricProviders.values())];
  }

  listMetrics(providerIds?: string[]): Metric[] {
    if (providerIds && providerIds.length !== 0) {
      return providerIds
        .map(providerId => {
          const provider = this.metricProviders.get(providerId);
          if (!provider) return undefined;

          if (provider.getMetrics) {
            const metrics = provider.getMetrics();
            return metrics.find(m => m.id === providerId);
          }

          return provider.getMetric();
        })
        .filter((m): m is Metric => m !== undefined);
    }

    // List all metrics from all providers (deduplicate batch providers)
    return this.listProviders().flatMap(
      provider => provider.getMetrics?.() ?? [provider.getMetric()],
    );
  }

  listMetricsByDatasource(datasourceId: string): Metric[] {
    const providerIdsOfDatasource = this.datasourceIndex.get(datasourceId);

    if (!providerIdsOfDatasource) {
      return [];
    }

    // Get unique providers for this datasource, then get their metrics
    const providers = [...providerIdsOfDatasource]
      .map(id => this.metricProviders.get(id))
      .filter((p): p is MetricProvider => p !== undefined);

    return [...new Set(providers)].flatMap(
      provider => provider.getMetrics?.() ?? [provider.getMetric()],
    );
  }
}
