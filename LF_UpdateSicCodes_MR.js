/**
 * Updates missing SIC codes for each client in the system,
 * by calling Companies House API
 *
 * @author Lukasz Formela <hello@lukaszformela.com>
 * @website lukaszformela.com
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/record', 'N/search', 'N/https', 'N/encode'], function (_record, _search, _https, _encode) {
  /**
   * Returns API key from custom Config record
   *
   * @returns {string} apiKey
   */
  const getApiKey = () => {
    const fieldLookup = _search.lookupFields({
      type: 'customrecord_lf_cfg',
      id: 1,
      columns: ['custrecord_lf_cfg_comp_hou_api_key'],
    });

    const apiKey = fieldLookup.custrecord_lf_cfg_comp_hou_api_key;

    return apiKey;
  };

  /**
   * Calls Companies House API
   *
   * https://developer-specs.company-information.service.gov.uk/guides/authorisation
   *
   * @param {string} companyId Company ID of client in NetSuite
   * @returns {object} response Response from Companies House API
   */
  const getCompaniesHouseApiResponse = (companyId) => {
    const apiKey = getApiKey();
    const password = '';
    const base64authString = _encode.convert({
      string: apiKey + ':' + password,
      inputEncoding: _encode.Encoding.UTF_8,
      outputEncoding: _encode.Encoding.BASE_64,
    });
    const requestHeaders = {
      Authorization: 'Basic ' + base64authString,
    };

    let searchableCompanyId = companyId;

    // Some IDs are missing leading 0, so API can't retrieve them.
    // If company ID consists of digits only, and total number of
    // characters is 7, add leading 0.
    if (companyId.match(/^[0-9]+$/) && companyId.length === 7) {
      searchableCompanyId = '0' + companyId;
    }

    // Some IDs have unnecessary spaces in the middle.
    // We will try to remove them and thus make potentially valid ID.
    if (companyId.match(/^\s+$/)) {
      searchableCompanyId = companyId.replace(/\s/g, '');
    }

    const requestUrl = 'https://api.companieshouse.gov.uk/company/' + searchableCompanyId;
    const response = _https.get({
      url: requestUrl,
      headers: requestHeaders,
    });

    return response;
  };

  /**
   * Extracts SIC codes from Companies House API response
   *
   * @param {string} response Response from Companies House API
   *
   * @returns {array} sicCodes Array of SIC Codes
   */
  const getSicCodesFromCompaniesHouseResponse = (response) => {
    const sicCodes = [];
    const responseBody = JSON.parse(response.body);

    if (response.code === 200 && responseBody.sic_codes) {
      responseBody.sic_codes.forEach((code) => {
        let usableCode = code;

        // System holds few 4-digit SIC codes values,
        // so we trim leading 0 from API retrieved codes
        if (code.slice(0, 1) === '0') {
          usableCode = code.slice(1);
        }

        sicCodes.push(usableCode);
      });
    }

    return sicCodes;
  };

  /**
   * Extracts company status from Companies House API response
   *
   * @param {string} response Response from Companies House API
   *
   * @returns {string} companyStatus Status of the company
   */
  const getCompanyStatusFromCompaniesHouseResponse = (response) => {
    const responseBody = JSON.parse(response.body);

    let companyStatus = '';

    if (response.code === 200 && responseBody.company_status) {
      companyStatus = responseBody.company_status;
    }

    return companyStatus;
  };

  /**
   * Updates SIC codes for specific client
   *
   * @param {object} record Client record
   * @param {array} sicCodes  An array of SIC codes from Companies House
   *
   * @returns {void}
   */
  const updateClientSicCodes = (record, sicCodes) => {
    let errorFound = false;

    sicCodes.forEach(function (sicCode) {
      log.debug({
        title: 'updateClientSicCodes',
        details: `Attempt to set SIC Code [${sicCode}] on record #${record.id}`,
      });

      try {
        record.setText({
          fieldId: 'custentity_sic_codes',
          text: sicCode,
        });
      } catch (err) {
        errorFound = true;
        log.debug({
          title: 'updateClientSicCodes - error',
          details: `Unable to update record #${record.id}; Incorrect/missing SIC code: ${sicCode}`,
        });

        record.setText({
          fieldId: 'custentity_sic_codes',
          text: '',
        });
      }
    });

    if (!errorFound) {
      record.setText({
        fieldId: 'custentity_sic_codes',
        text: sicCodes,
      });

      log.debug({
        title: 'updateClientSicCodes',
        details: `Setting SIC codes [${sicCodes.join(', ')}] on record #${record.id}`,
      });

      const sicDescriptions = getSicDescriptions(sicCodes);
      if (sicDescriptions.length > 0) {
        record.setValue({
          fieldId: 'custentity_sic_description',
          value: sicDescriptions.join('; '),
        });
      }
    }
  };

  /**
   * Updates company status for specific client
   *
   * @param {object} record Client record
   * @param {string} companyStatus Named company status from Companies House response
   *
   * @returns {void}
   */
  const updateClientCompanyStatus = (record, companyStatus) => {
    record.setText({
      fieldId: 'custentity_company_status',
      text: companyStatus,
    });
  };

  /**
   * Deactivates company if:
   *  - company status is not "Active",
   *  - Balance = 0,
   *  - Overdue Balance = 0,
   *  - Unbilled Orders = 0
   *
   * @param {object} record Client record
   * @param {string} companyStatus Named company status from Companies House response
   *
   * @returns {void}
   */
  const updateClientAccount = (record, companyStatus) => {
    if (companyStatus !== 'active') {
      const balance = record.getValue({
        fieldId: 'balance',
      });
      const overdueBalance = record.getValue({
        fieldId: 'overduebalance',
      });
      const unbilledOrders = record.getValue({
        fieldId: 'unbilledorders',
      });

      if (balance === 0 && overdueBalance === 0 && unbilledOrders === 0) {
        log.debug({
          title: 'updateClientAccount()',
          details: `Company record deactivated: ${record.id}`,
        });

        record.setValue({
          fieldId: 'isinactive',
          value: true,
        });
      }
    }
  };

  /**
   * Retrieves SIC descriptions from the system.
   * Required when SIC codes multiselect have more than one value selected,
   * as NetSuite can't map text field to multiselect one in order to
   * autopopulate it.
   *
   * @param {array} sicCodes An array of SIC codes received from
   *                         Companies House API
   *
   * @returns {array} results
   */
  const getSicDescriptions = (sicCodes) => {
    const data = {
      recodsCount: 0,
      records: [],
    };
    const searchableSicCodesString = sicCodes.join(' OR ');

    _search
      .create({
        type: 'customrecord_sic_codes',
        filters: [['name', _search.Operator.HASKEYWORDS, searchableSicCodesString]],
        columns: ['custrecord_siccodes_description'],
      })
      .run()
      .each((result) => {
        const sicDescription = result.getValue({
          name: 'custrecord_siccodes_description',
        });

        data.records.push(sicDescription);
        data.recordsCount += 1;

        return true;
      });

    return data;
  };

  /**
   * Marks the beginning of the Map/Reduce process and generates input data.
   *
   * @typedef {Object} ObjectRef
   * @property {number} id - Internal ID of the record instance
   * @property {string} type - Record type id
   *
   * @return {Array|Object|Search|RecordRef} inputSummary
   * @since 2015.1
   */
  const getInputData = () => {
    // Pull active Customers that have Company Number set
    const search = _search.create({
      type: _record.Type.CUSTOMER,
      filters: [
        ['custentity_company_no', _search.Operator.ISNOTEMPTY, ''],
        'AND',
        ['isinactive', _search.Operator.IS, 'F'],
      ],
      columns: [
        'entityid',
        'custentity_company_no',
        'custentity_sic_codes',
        _search.createColumn({
          name: 'lastmodifieddate',
          sort: _search.Sort.DESC,
        }),
      ],
    });

    // Companies House API has a limit
    // of 600 calls per 5 minutes
    const results = search.run().getRange({
      start: 0,
      end: 600,
    });

    return results;
  };

  /**
   * Executes when the map entry point is triggered and applies to each key/value pair.
   *
   * @param {MapSummary} context - Data collection containing the key/value pairs to process through the map stage
   * @since 2015.1
   *
   * @returns {boolean} true
   */
  const map = (context) => {
    const value = JSON.parse(context.value);
    const companyNo = value.values.custentity_company_no;

    if (!companyNo) {
      return true;
    }

    const clientId = value.id;
    const apiResponse = getCompaniesHouseApiResponse(companyNo);
    const sicCodes = getSicCodesFromCompaniesHouseResponse(apiResponse);
    const companyStatus = getCompanyStatusFromCompaniesHouseResponse(apiResponse);

    if (sicCodes.length > 0 || companyStatus) {
      const record = _record.load({
        type: _record.Type.CUSTOMER,
        id: clientId,
      });

      if (sicCodes.length > 0) {
        updateClientSicCodes(record, sicCodes);
      }

      if (companyStatus) {
        updateClientCompanyStatus(record, companyStatus);
        updateClientAccount(record, companyStatus);
      }

      record.save();
    }

    return true;
  };

  /**
   * Executes when the summarize entry point is triggered and applies to the result set.
   *
   * @param {Summary} summary - Holds statistics regarding the execution of a map/reduce script
   * @since 2015.1
   *
   * @returns {void}
   */
  const summarize = (summary) => {
    // getInput() stage errors
    if (summary.inputSummary.error) {
      log.error({
        title: 'Input Error',
        details: summary.inputSummary.error,
      });
    }

    // map() stage errors
    summary.mapSummary.errors.iterator().each((key, error) => {
      log.error({
        title: `Map Error for key: ${key}`,
        details: error,
      });

      return true;
    });

    // reduce() stage errors
    summary.reduceSummary.errors.iterator().each((key, error) => {
      log.error({
        title: `Reduce Error for key: ${key}`,
        details: error,
      });

      return true;
    });
  };

  return {
    getInputData,
    map,
    summarize,
  };
});
