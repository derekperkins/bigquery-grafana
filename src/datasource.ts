import _ from 'lodash';
import ResponseParser from './response_parser';
import BigQueryQuery from './bigquery_query';
import {ResultFormat} from "./response_parser";

export class BigQueryDatasource {
    id: any;
    name: any;
    jsonData: any;
    responseParser: ResponseParser;
    queryModel: BigQueryQuery;
    interval: string;
    baseUrl: string;
    url: string;
    authenticationType: string;
    projectName: string;

    /** @ngInject */
    constructor(instanceSettings, private backendSrv, private $q, private templateSrv, private timeSrv) {
        this.name = instanceSettings.name;
        this.id = instanceSettings.id;
        this.jsonData = instanceSettings.jsonData;
        this.responseParser = new ResponseParser(this.$q);
        this.queryModel = new BigQueryQuery({});
        this.baseUrl = `/bigquery/`;
        this.url = instanceSettings.url;
        this.interval = (instanceSettings.jsonData || {}).timeInterval || '1m';
        this.authenticationType = instanceSettings.jsonData.authenticationType || 'jwt';
        this.projectName = instanceSettings.jsonData.defaultProject || '';
    }

    async doRequest(url, maxRetries = 1) {
        return this.backendSrv
            .datasourceRequest({
                url: this.url + url,
                method: 'GET',
            })
            .catch(error => {
                if (maxRetries > 0) {
                    return this.doRequest(url, maxRetries - 1);
                }
                console.log(error);
                throw error;
            });
    }

    async doQueryRequest(url, query, maxRetries = 1) {
        return this.backendSrv
            .datasourceRequest({
                url: this.url + url,
                method: 'POST',
                data: {
                    query : query,
                    useLegacySql: false,
                },
            })
            .catch(error => {
                if (maxRetries > 0) {
                    return this.doQueryRequest(url,query, maxRetries - 1);
                }
                throw error;
            });
    }
    interpolateVariable = (value, variable) => {
        if (typeof value === 'string') {
            if (variable.multi || variable.includeAll) {
                return this.queryModel.quoteLiteral(value);
            } else {
                return value;
            }
        }

        if (typeof value === 'number') {
            return value;
        }

        const quotedValues = _.map(value, v => {
            return this.queryModel.quoteLiteral(v);
        });
        return quotedValues.join(',');
    };

    query(options) {
        const queries = _.filter(options.targets, target => {
            return target.hide !== true;
        }).map(target => {
            const queryModel = new BigQueryQuery(target, this.templateSrv, options.scopedVars);
            this.queryModel = queryModel
            return {
                refId: target.refId,
                intervalMs: options.intervalMs,
                maxDataPoints: options.maxDataPoints,
                datasourceId: this.id,
                rawSql: queryModel.render(this.interpolateVariable),
                format: target.format,
            };
        });

        if (queries.length === 0) {
            return this.$q.when({data: []});
        }
        let q = this.queryModel.expend_macros(options);
        const path = `v2/projects/${this.projectName}/queries`;
        return this.doQueryRequest(`${this.baseUrl}${path}`,q).then(response => {
            return new ResponseParser(this.$q).parseDataQuery(response);
        });
    }

    annotationQuery(options) {
        if (!options.annotation.rawQuery) {
            return this.$q.reject({
                message: 'Query missing in annotation definition',
            });
        }

        const query = {
            refId: options.annotation.name,
            datasourceId: this.id,
            rawSql: this.templateSrv.replace(options.annotation.rawQuery, options.scopedVars, this.interpolateVariable),
            format: 'table',
        };
        return this.backendSrv
            .datasourceRequest({
                url: '/api/tsdb/query',
                method: 'POST',
                data: {
                    from: options.range.from.valueOf().toString(),
                    to: options.range.to.valueOf().toString(),
                    queries: [query],
                },
            })
            .then(data => this.responseParser.transformAnnotationResponse(options, data));
    }

    getProjects(): Promise<ResultFormat[]> {
        const path = `v2/projects`;
        return this.doRequest(`${this.baseUrl}${path}`).then(response => {
            return new ResponseParser(this.$q).parseProjects(response);
        });
    }

    getDatasets(projectName): Promise<ResultFormat[]> {
        const path = `v2/projects/${projectName}/datasets`;
        return this.doRequest(`${this.baseUrl}${path}`).then(response => {
            return new ResponseParser(this.$q).parseDatasets(response);
        });
    }

    getTables(projectName, datasetName): Promise<ResultFormat[]> {
        const path = `v2/projects/${projectName}/datasets/${datasetName}/tables`;
        return this.doRequest(`${this.baseUrl}${path}`).then(response => {
            return new ResponseParser(this.$q).parseTabels(response);
        });
    }

    getTableFields(projectName, datasetName, tableName, filter): Promise<ResultFormat[]> {
        const path = `v2/projects/${projectName}/datasets/${datasetName}/tables/${tableName}`;
        return this.doRequest(`${this.baseUrl}${path}`).then(response => {
            return new ResponseParser(this.$q).parseTabelFields(response, filter);
        });
    }

    metricFindQuery(query, optionalOptions) {
        let refId = 'tempvar';
        if (optionalOptions && optionalOptions.variable && optionalOptions.variable.name) {
            refId = optionalOptions.variable.name;
        }

        const interpolatedQuery = {
            refId: refId,
            datasourceId: this.id,
            rawSql: this.templateSrv.replace(query, {}, this.interpolateVariable),
            format: 'table',
        };

        const range = this.timeSrv.timeRange();
        const data = {
            queries: [interpolatedQuery],
            from: range.from.valueOf().toString(),
            to: range.to.valueOf().toString(),
        };
        return this.backendSrv
            .datasourceRequest({
                url: '/api/tsdb/query',
                method: 'POST',
                data: data,
            })
            .then(data => this.responseParser.parseMetricFindQueryResult(refId, data));
    }


    async getDefaultProject() {
        try {
            if (this.authenticationType === 'gce' || !this.projectName) {
                const {data} = await this.backendSrv.datasourceRequest({
                    url: '/api/tsdb/query',
                    method: 'POST',
                    data: {
                        queries: [
                            {
                                refId: 'ensureDefaultProjectQuery',
                                type: 'ensureDefaultProjectQuery',
                                datasourceId: this.id,
                            },
                        ],
                    },
                });
                this.projectName = data.results.ensureDefaultProjectQuery.meta.defaultProject;
                return this.projectName;
            } else {
                return this.projectName;
            }
        } catch (error) {
            throw BigQueryDatasource.formatBigqueryError(error);
        }
    }

    async testDatasource() {
        let status, message;
        const defaultErrorMessage = 'Cannot connect to BigQuery API';
        try {
            const projectName = await this.getDefaultProject();
            const path = `v2/projects/${projectName}/datasets`;
            const response = await this.doRequest(`${this.baseUrl}${path}`);
            if (response.status === 200) {
                status = 'success';
                message = 'Successfully queried the BigQuery API.';
            } else {
                status = 'error';
                message = response.statusText ? response.statusText : defaultErrorMessage;
            }
        } catch (error) {
            console.log(error);
            status = 'error';
            if (_.isString(error)) {
                message = error;
            } else {
                message = 'BigQuery: ';
                message += error.statusText ? error.statusText : defaultErrorMessage;
                if (error.data && error.data.error && error.data.error.code) {
                    message += ': ' + error.data.error.code + '. ' + error.data.error.message;
                }
            }
        } finally {
            return {
                status,
                message,
            };
        }
    }

    static formatBigqueryError(error) {
        let message = 'BigQuery: ';
        message += error.statusText ? error.statusText + ': ' : '';
        if (error.data && error.data.error) {
            try {
                const res = JSON.parse(error.data.error);
                message += res.error.code + '. ' + res.error.message;
            } catch (err) {
                message += error.data.error;
            }
        } else {
            message += 'Cannot connect to BigQuery API';
        }
        return message;
    }

}
