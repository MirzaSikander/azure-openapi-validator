/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { nodes } from "jsonpath"

function unionArray(left: string[], right: string[]) {
  return left.reduce((au, u) => (au.includes(u) ? au : [...au, u]), right)
}

function unionModels(left: Map<string, string[]>, right: Map<string, string[]>) {
  const result = new Map<string, string[]>(right)
  for (const entry of left.entries()) {
    if (!right.has(entry[0])) {
      result.set(entry[0], entry[1])
    } else {
      const rightValue = right.get(entry[0])
      result.set(entry[0], unionArray(left.get(entry[0]), rightValue))
    }
  }
  return result
}

function exceptModels(source: Map<string, string[]>, toExcept: Map<string, string[]>) {
  const result = new Map<string, string[]>()
  for (const entry of source.entries()) {
    if (!toExcept.has(entry[0])) {
      result.set(entry[0], entry[1])
    }
  }
  return result
}
export interface CollectionApiInfo {
  modelName: string
  childModelName: string
  collectionGetPath: string
  specificGetPath: string
}
/**
 * this class only handle swagger without external refs, as the linter's input is a external-refs-resolved swagger
 */
export class ResourceUtils {
  private innerDoc: any
  private BaseResourceModelNames = ["trackedresource", "proxyresource", "resource"]
  private ResourceProviderPathPattern = new RegExp("/providers/(?<resPath>[^{/]+)/", "ig")

  private ResourcePathPattern = new RegExp("(/\\w+/{\\w+})+$")

  private OnlyTopLevelResourcePathPattern = new RegExp("/providers/\\w+/\\w+$", "ig")

  private ListBySidRegEx = new RegExp(".+_(List|ListBySubscriptionId|ListBySubscription|ListBySubscriptions)$", "ig")
  private ListByRgRegEx = new RegExp(".+_ListByResourceGroup$", "ig")
  private TenantResourceRegEx = new RegExp("^/subscriptions/{.+}/resourceGroups/{.+}/", "gi")
  private ListBySubscriptionsResourceRegEx = new RegExp("^/subscriptions/{.+}/providers/", "gi")

  private OperationApiRegEx = new RegExp("^/providers/{[^/]+}/operations$", "gi")
  private SpecificResourcePathRegEx = new RegExp("/providers/[^/]+(/\\w+/{[^/}]+})+$", "gi")

  private XmsResources = new Set<string>()
  private AllResources = new Set<string>()

  constructor(swagger: object) {
    this.innerDoc = swagger
    this.getXmsResources()
  }

  public stripDefinitionPath(reference: string) {
    const refPrefix = "#/definitions/"
    if (reference && reference.startsWith(refPrefix)) {
      return reference.substr(refPrefix.length)
    }
  }

  private addToMap(map: Map<string, string[]>, key: string, value: string) {
    if (map.has(key)) {
      map.set(key, map.get(key).concat(value))
    } else {
      map.set(key, [value])
    }
  }

  private getSpecificOperationModels(httpVerb, code) {
    const models: Map<string, string[]> = new Map<string, string[]>()
    const getModel = node => {
      if (node && node.value) {
        const response = node.value
        if (response.schema && response.schema.$ref) {
          const modelName = this.stripDefinitionPath(response.schema.$ref)
          if (modelName) {
            this.addToMap(models, modelName, node.path[2] as string)
          }
        }
      }
    }
    for (const node of nodes(this.innerDoc, `$.paths.*.${httpVerb}.responses.${code}`)) {
      getModel(node)
    }
    for (const node of nodes(this.innerDoc, `$['x-ms-paths'].*.${httpVerb}.responses.${code}`)) {
      getModel(node)
    }
    return models
  }

  private *jsonPathIt(doc, jsonPath: string): Iterable<any> {
    if (doc) {
      for (const node of nodes(doc, jsonPath)) {
        yield node.value
      }
    }
  }

  private getXmsResources() {
    for (const node of nodes(this.innerDoc, `$.definitions.*`)) {
      const model = node.value
      for (const extension of this.jsonPathIt(model, `$..['x-ms-azure-resource']`)) {
        if (extension === true) {
          this.XmsResources.add(node.path[2] as string)
        }
      }
    }
  }

  private getResourceByName(modelName: string) {
    for (const node of nodes(this.innerDoc, `$.definitions.${modelName}`)) {
      return node.value
    }
  }

  private checkResource(modelName: string) {
    const model = this.getResourceByName(modelName)
    for (const refs of this.jsonPathIt(model, `$.allOf`)) {
      for (const ref of refs) {
        const refPoint = ref.$ref
        const subModel = this.stripDefinitionPath(refPoint)
        if (!subModel) {
          continue
        }
        if (this.BaseResourceModelNames.indexOf(subModel.toLowerCase()) !== -1) {
          return true
        }
        if (this.XmsResources.has(subModel)) {
          return true
        }
        if (this.checkResource(subModel)) {
          return true
        }
      }
    }
    return false
  }

  public getAllOfResources() {
    const keys = Object.keys(this.innerDoc.definitions as object)
    const AllOfResources = keys.reduce((pre, cur) => {
      if (this.getResourceHierarchy(cur).some(model => this.XmsResources.has(model))) {
        return [...pre, cur]
      } else {
        return pre
      }
    }, [])
    return AllOfResources
  }

  public getAllOperationGetResponseModels() {
    return this.getSpecificOperationModels("get", "200")
  }

  private getOperationGetResponseModels() {
    const models = [...this.getAllOperationGetResponseModels().entries()].filter(m => this.checkResource(m[0]))
    return new Map(models)
  }

  private getAllOperationsModels() {
    const putOperationModels = unionModels(this.getSpecificOperationModels("put", "200"), this.getSpecificOperationModels("put", "201"))
    const getOperationModels = this.getOperationGetResponseModels()
    const operationModels = unionModels(putOperationModels, getOperationModels)
    const postOperationModels = this.getSpecificOperationModels("post", "*")
    const postOnlyModels = exceptModels(postOperationModels, operationModels)
    return exceptModels(operationModels, postOnlyModels)
  }

  public getAllNestedResources() {
    const fullModels = this.getAllOperationsModels()
    const nestedModels = new Set<string>()
    for (const entry of fullModels.entries()) {
      const paths = entry[1]
      paths.some(p => {
        const hierarchy = this.getResourcesTypeHierarchy(p)
        if (hierarchy.length > 1) {
          nestedModels.add(entry[0])
          return true
        }
      })
    }
    return nestedModels
  }

  /**
   * Check the following conditions , a model be considered as a top-level resource
   * 1 when a model existing in a get/put operation and 200/201 response, consider as a resource
   * 2 when the path match the pattern: /subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Network/expressRouteCircuits/{circuitName}
   */
  public getAllTopLevelResources() {
    const fullModels = this.getAllOperationsModels()
    const topLevelModels = new Set<string>()
    for (const entry of fullModels.entries()) {
      const paths = entry[1]
      paths.some(p => {
        const hierarchy = this.getResourcesTypeHierarchy(p)
        if (hierarchy.length === 1) {
          topLevelModels.add(entry[0])
          return true
        }
      })
    }
    return topLevelModels
  }
  /**
   *
   * @param path
   * case 1 : '/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Network/applicationGateways'
   * return ["applicationGateways"]
   * case 2: '/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Network/expressRouteCircuits/{circuitName}/peerings/{peeringName}'
   * return ["expressRouteCircuits","peerings"]
   */
  private getResourcesTypeHierarchy(path: string) {
    const lastProvider = path.substr(path.lastIndexOf("/providers/"))
    const result = []
    if (!lastProvider) {
      return result
    }
    const matches = lastProvider.match(this.ResourcePathPattern)
    if (matches && matches.length) {
      let match = matches[0]
      while (match.indexOf("/{") !== -1) {
        result.push(match.substr(1, match.indexOf("/{") - 1))
        if (match.indexOf("}/") !== -1) {
          match = match.substr(match.indexOf("}/") + 1)
        } else {
          match = ""
        }
      }
    } else {
      const matches = lastProvider.match(this.OnlyTopLevelResourcePathPattern)
      if (matches) {
        const match = matches[0]
        result.push(match.substr(match.lastIndexOf("/") + 1))
      }
    }
    return result
  }

  /**
   * hierarchy base on keyword:allOf
   * @param modelName
   */
  private getResourceHierarchy(modelName: string) {
    let hierarchy = []
    const model = this.getResourceByName(modelName)
    if (!model) {
      return hierarchy
    }
    for (const refs of this.jsonPathIt(model, `$.allOf`)) {
      refs.forEach(ref => {
        const allOfModel = this.stripDefinitionPath(ref.$ref)
        hierarchy.push(allOfModel)
        hierarchy = hierarchy.concat(this.getResourceHierarchy(allOfModel))
      })
    }
    return hierarchy
  }

  public containsDiscriminator(modelName: string) {
    const hierarchy = this.getResourcesTypeHierarchy(modelName)
    if (hierarchy.length > 0) {
      const resource = this.getResourceByName(hierarchy[0])
      if (resource && typeof resource.discriminator === "string") {
        return true
      }
    }
  }

  /**
   * return [{operationPath}:{schema}]
   */

  public getOperationApi() {
    for (const pathNode of nodes(this.innerDoc, "$.paths.*")) {
      const path = pathNode.path[2] as string
      const matchResult = path.match(this.OperationApiRegEx)
      if (matchResult) {
        return [path, this.stripDefinitionPath(pathNode.value?.get?.response["200"]?.schema?.$ref)]
      }
    }
    return undefined
  }

  /**
   * get a model and its collection api path mapping
   *      Case 1: /subscriptions/{subscriptionId}/resourceGroup/{resourceGroupName}/providers/Microsoft.Sql/servers/{server1}
   *      Case 2: /subscriptions/{subscriptionId}/resourceGroup/{resourceGroupName}/providers/Microsoft.Sql/servers
   * if case 1 and case 2 both existing , consider case 2 is collection api.
   */

  public getCollectionApiInfo() {
    let allPathKeys = Object.keys(this.innerDoc.paths)
    if (this.innerDoc["x-ms-paths"]) {
      allPathKeys = allPathKeys.concat(Object.keys(this.innerDoc["x-ms-paths"]))
    }
    const modelMapping = this.getAllOperationsModels()
    const collectionResources = this.getCollectionResources()
    const getOperationResources = this.getOperationGetResponseModels()
    const collectionApis: CollectionApiInfo[] = []
    for (const modelEntry of modelMapping.entries()) {
      if (!getOperationResources.has(modelEntry[0])) {
        continue
      }
      modelEntry[1].forEach(path => {
        if (path.match(this.SpecificResourcePathRegEx)) {
          const possibleCollectionApiPath = path.substr(0, path.lastIndexOf("/{"))
          /*
          *  case 1:"providers/Microsoft.Compute/virtualMachineScaleSets/{virtualMachineScaleSetName}/virtualMachines"
            case 2: "providers/Microsoft.Compute/virtualMachineScaleSets/{vmScaleSetName}/virtualMachines":
            case 1 and case 2 should be the same, as the difference of parameter name does not have impact
          */
          const matchedPaths = allPathKeys.filter(
            p => p.replace(/{[^\/]+}/gi, "{}") === possibleCollectionApiPath.replace(/{[^\/]+}/, "{}")
          )
          if (matchedPaths && matchedPaths.length >= 1) {
            matchedPaths.forEach(m =>
              collectionApis.push({
                specificGetPath: path,
                collectionGetPath: possibleCollectionApiPath,
                modelName: this.getModelFromPath(m),
                childModelName: modelEntry[0]
              })
            )
          }
        }
      })
    }
    /**
     * if a resource definition the match a collection resource schema, we can back-stepping the corresponding operation to make sure
     * we don't lost it
     */
    for (const resource of collectionResources) {
      if (getOperationResources.has(resource[1]) && collectionApis.some(e => e.modelName !== resource[1])) {
        collectionApis.push({
          specificGetPath: getOperationResources[resource[0]],
          collectionGetPath: getOperationResources[resource[1]],
          modelName: resource[1],
          childModelName: resource[0]
        })
      }
    }

    return collectionApis
  }

  /**
   * get collection resource from definition by finding the model which match the conditions:
   * 1 type == array
   * 2 its items refers one of resources definition
   */
  public getCollectionResources() {
    const resourceModel = this.getOperationGetResponseModels()
    const resourceCollectMap = new Map<string, string>()
    const doc = this.innerDoc

    for (const resourceNode of this.jsonPathIt(doc, "$.definitions.*")) {
      for (const arrayNode of nodes(resourceNode, "$..[?(@.type == 'array')]")) {
        const arrayObj = arrayNode.value
        const items = arrayObj?.items
        if (items && resourceModel.has(this.stripDefinitionPath(items.$ref))) {
          resourceCollectMap.set(this.stripDefinitionPath(items.$ref), arrayNode.path[1] as string)
        }
      }
    }
    return resourceCollectMap
  }

  public isPathBySubscription(path: string) {
    return !!path.match(this.ListBySubscriptionsResourceRegEx)
  }

  public isPathByResourceGroup(path: string) {
    return !!path.match(this.TenantResourceRegEx)
  }

  public getModelFromPath(path: string) {
    let pathObj = this.innerDoc.paths[path]
    if (!pathObj && this.innerDoc["x-ms-paths"]) {
      pathObj = this.innerDoc["x-ms-paths"][path]
    }
    if (pathObj && pathObj.get && pathObj.get.responses["200"]) {
      return this.stripDefinitionPath(pathObj.get.responses["200"]?.schema?.$ref)
    }
  }

  public getOperationIdFromPath(path: string, code = "get") {
    let pathObj = this.innerDoc.paths[path]
    if (!pathObj && this.innerDoc["x-ms-paths"]) {
      pathObj = this.innerDoc["x-ms-paths"][path]
    }
    if (pathObj && pathObj[code]) {
      return pathObj[code].operationId
    }
  }

  private dereference(ref: string) {
    return this.getResourceByName(this.stripDefinitionPath(ref))
  }

  /**
   * get property of model recursively, if not found return undefined
   */
  public getPropertyOfModelName(modelName: string, propertyName: string) {
    const model = this.getResourceByName(modelName)
    if (!model) {
      return undefined
    }
    if (model.properties) {
      if (model.properties[propertyName]) {
        const ref = model.properties[propertyName].$ref
        return ref ? this.dereference(ref) : model.properties[propertyName]
      }
    }
    if (model.allOf) {
      for (const element of model.allOf) {
        const property = this.getPropertyOfModelName(this.stripDefinitionPath(element.$ref), propertyName)
        if (property) {
          const ref = property.$ref
          return ref ? this.dereference(ref) : property
        }
      }
    }
  }

  public getPropertyOfModel(sourceModel, propertyName: string) {
    if (!sourceModel) {
      return undefined
    }
    let model = sourceModel
    if (sourceModel.$ref) {
      model = this.getResourceByName(this.stripDefinitionPath(sourceModel))
    }
    if (model.properties) {
      if (model.properties[propertyName]) {
        const ref = model.properties[propertyName].$ref
        return ref ? this.dereference(ref) : model.properties[propertyName]
      }
    }
    if (model.allOf) {
      for (const element of model.allOf) {
        const property = this.getPropertyOfModelName(this.stripDefinitionPath(element.$ref), propertyName)
        if (property) {
          const ref = property.$ref
          return ref ? this.dereference(ref) : property
        }
      }
    }
  }

  /**
   *
   * @param collectionModel
   * @param childModelName
   *
   * case 1: value : {
   *  type:array,
   *  items:{
   *    "refs":"#/definitions/"
   *  }
   * }
   */
  public verifyCollectionModel(collectionModel, childModelName: string) {
    if (collectionModel) {
      if (collectionModel.type === "array" && collectionModel.items) {
        const itemsRef = collectionModel.items.$ref
        if (this.stripDefinitionPath(itemsRef) === childModelName) {
          return true
        }
      }
    }
  }

  /**
   * 1 get resource from operation responses
   * 2 get resource from allOffing x-ms-azure-resource
   */
  public getAllResources() {
    return this.getAllOfResources()
      .reduce((au, u) => (au.includes(u) ? au : [...au, u]), [...this.getAllOperationsModels().keys()])
      .filter(e => this.BaseResourceModelNames.indexOf(e.toLowerCase()) === -1)
  }
}
