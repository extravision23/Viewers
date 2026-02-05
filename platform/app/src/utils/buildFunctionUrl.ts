/**
 * Gets the base URL for Python functions
 */
export const getFunctionsBaseUrl = (dataSourceConfig: any): string | undefined => {
  return (
    dataSourceConfig?.pythonFunctionsBaseUrl ||
    (dataSourceConfig?.pythonFunctionName
      ? `https://${dataSourceConfig.pythonFunctionName}.azurewebsites.net/api`
      : undefined)
  );
};

/**
 * Builds a function URL for Python Azure Functions
 * @param dataSourceConfig - The data source configuration
 * @param functionName - The name of the function (e.g., 'fusion/ct-mr')
 * @returns The full URL to the function
 */
export const buildFunctionUrl = (dataSourceConfig: any, functionName: string): string => {
  const baseUrl = getFunctionsBaseUrl(dataSourceConfig);
  if (!baseUrl) {
    throw new Error('No python functions base url configured');
  }
  return `${baseUrl}/${functionName}`;
};
