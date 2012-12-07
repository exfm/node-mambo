"use strict";

var dynamo = require("dynamo"),
    when = require("when"),
    sequence = require("sequence"),
    _ = require("underscore"),
    Query = require('./lib/query'),
    UpdateQuery = require('./lib/update-query'),
    Batch = require('./lib/batch'),
    Schema = require('./lib/schema'),
    fields = require('./lib/fields'),
    Inserter = require('./lib/inserter'),
    util = require('util'),
    EventEmitter = require('events').EventEmitter,
    plog = require('plog'),
    log = plog('mambo').level('error');


// Models have many tables.
function Model(){
    this.connected = false;
    this.tables = {};
    this.schemas = Array.prototype.slice.call(arguments, 0);
    this.schemasByName = {};

    this.schemas.forEach(function(schema){
        this.schemasByName[schema.alias] = schema;
    }.bind(this));

    this.tablesByName = {};
}
util.inherits(Model, EventEmitter);

// Grab a schema definition by alias.
Model.prototype.schema = function(alias){
    return this.schemasByName[alias];
};

// Get a dynamo table object by alias.
Model.prototype.table = function(alias){
    return this.tables[alias];
};

Model.prototype.tableNameToAlias = function(name){
    return this.tablesByName[name].alias;
};

// Fetch a query wrapper Django style.
Model.prototype.objects = function(alias, hash, range){
    if(typeof range === 'object'){
        var d = when.defer(),
            key = Object.keys(range)[0],
            q = new Query(this, alias, hash);
        q.fetch().then(function(results){
            d.resolve(results.filter(function(res){
                return res[key] === range[key];
            })[0]);
        }, function(){
            throw new Error();
        });
        return d.promise;

    }
    else{
        return new Query(this, alias, hash, range);
    }
};

Model.prototype.insert = function(alias){
    return new Inserter(this, alias);
};

Model.prototype.update = function(alias, hash, range){
    var q =  new UpdateQuery(this, alias, hash);
    if(range){
        q.range = range;
    }
    return q;
};

Model.prototype.batch = function(){
    return new Batch(this);
};


// Actually connect to dynamo or magneto.
Model.prototype.getDB = function(key, secret){
    if(process.env.MAMBO_BACKEND === "magneto"){
        log.debug('Using magneto');
        // Connect to Magneto
        this.client = dynamo.createClient();
        this.client.useSession = false;
        this.db = this.client.get(this.region || "us-east-1");
        this.db.host = "localhost";
        this.db.port = process.env.MAGNETO_PORT || 8081;
        log.debug('Connected to magneto on ' +this.db.host+ ':' + this.db.port);
    }
    else {
        // Connect to DynamoDB
        this.client = dynamo.createClient({
            'accessKeyId': key,
            'secretAccessKey': secret
        });
        this.db = this.client.get(this.region || "us-east-1");
        log.debug('Dynamo client created.');
    }
    return this.db;
};

Model.prototype.connect = function(key, secret, prefix, region){
    log.debug('Connecting...');

    this.prefix = prefix;
    this.region = region;
    this.getDB(key, secret);

    log.debug('Reading schemas...');
    this.schemas.forEach(function(schema){
        var tableName = (this.prefix || "") + schema.tableName,
            table = this.db.get(tableName);

        log.silly('Table name: ' + tableName);

        _.extend(table, {
            'name': table.TableName,
            'alias': schema.alias,
            'hashType': schema.hashType,
            'hashName': schema.hash,
            'key': {
                'HashKeyElement': {}
            }
        });
        table.key.HashKeyElement[schema.hashType] = schema.hash;

        if(schema.range){
            _.extend(table, {
                'rangeType': schema.rangeType,
                'rangeName': schema.range
            });
            table.key.HashKeyElement[schema.rangeType] = schema.range;
        }

        this.tables[table.alias] = this.tablesByName[tableName] = table;
    }.bind(this));

    this.connected = true;
    log.debug('Ready.  Emitting connect.');

    this.emit('connect');
    return this;
};

// Create all tables as defined by this models schemas.
Model.prototype.createAll = function(){
    var d = when.defer();
    when.all(Object.keys(this.tables).map(this.ensureTableMagneto.bind(this)),
        d.resolve);

    return d.promise;
};

// Checks if all tables exist in magneto.  If a table doesn't exist
// it will be created.
Model.prototype.ensureTableMagneto = function(alias){
    var d = when.defer();
    sequence(this).then(function(next){
        this.db.listTables({}, next);
    }).then(function(next, err, data){
        if(!d.rejectIfError(err)){
            next(data);
        }
    }).then(function(next, data){
        if(data.TableNames.indexOf(this.table(alias).name) !== -1){
            return d.resolve(false);
        }
        this.db.add({
            'name': this.table(alias).name,
            'schema': this.schema(alias).schema,
            'throughput': {
                'read': 10,
                'write': 10
            }
        }).save(function(err, table){
            if(!d.rejectIfError(err)){
                d.resolve(true);
            }
        });
    });
    return d.promise;
};

// Low level get item wrapper.
// Params:
// - alias: The table alias name
// - hash: the value of the key-hash of the object you want to retrieve, eg:
// - the song ID
// - range: the value of the key-range of the object you want to retrieve
// - attributesToGet: An array of names of attributes to return in each
// - object. If empty, get all attributes.
// - consistentRead: boolean
Model.prototype.get = function(alias, hash, range, attributesToGet, consistentRead){
    var d = when.defer(),
        table = this.table(alias),
        schema = this.schema(alias),
        request;
    log.debug('Get `'+alias+'` with hash `'+hash+'` and range `'+range+'`');

    // Assemble the request data
    request = {
        'TableName': table.name,
        'Key': {
            'HashKeyElement': {}
        }
    };

    request.Key.HashKeyElement[schema.field(schema.hash).type] = schema.field(schema.hash).export(hash);

    if(schema.range){
        request.Key.RangeKeyElement = {};
        request.Key.RangeKeyElement[schema.field(schema.range).type] = schema.field(schema.range).export(range);
    }

    if(attributesToGet && attributesToGet.length > 0){
        // Get only `attributesToGet`
        request.AttributesToGet = attributesToGet;
    }
    if(consistentRead){
        request.ConsistentRead = consistentRead;
    }

    log.silly('Built GET_ITEM request: ' + util.inspect(request, false, 5));

    // Make the request
    this.db.getItem(request, function(err, data){
        log.silly('GET_ITEM returned: err: ' + err + ', data: ' + util.inspect(data, false, 5));
        if(!d.rejectIfError(err)){
            return d.resolve((data.Item !== undefined) ?
                    this.schema(alias).import(data.Item) : null);
        }
        else{
            log.error('GET_ITEM: ' + err.message + '\n' + err.stack);
        }
    }.bind(this));

    return d.promise;
};

// Lowlevel delete item wrapper
// example:
//     delete('alias', 'hash', {
//          'range': 'blahblah',
//          'expectedValues': [{
//              'attributeName': 'attribute_name',
//              'expectedValue': 'current_value', // optional
//              'exists': 'true' // defaults to true
//            }],
//          'returnValues':  'NONE'
//        })
Model.prototype.delete = function(alias, hash, opts){
    opts = opts || {};

    log.debug('Delete `'+alias+'` with hash `'+hash+'` and range `'+opts.range+'`');

    var d = when.defer(),
        table = this.table(alias),
        request = {
            'TableName': table.name,
            'Key': {
                'HashKeyElement': {}
            },
            'ReturnValues': opts.returnValues || 'NONE'
        };

    // Add hash
    request.Key.HashKeyElement[table.hashType] = hash.toString();

    // Add range
    if(opts.range){
        request.Key.RangeKeyElement = {};
        request.Key.RangeKeyElement[table.rangeType] = opts.range.toString();
    }

    // Add expectedValues for conditional delete
    if(opts.expectedValues){
        request.Expected = {};
        opts.expectedValues.forEach(function(attr){
            var expectedAttribute = {
                    'Exists': attr.exists || Number(true)
                },
                field = this.schema(alias).field(attr.attributeName);

            if (attr.expectedValue) {
                expectedAttribute.Value = {};
                expectedAttribute.Value[field.type] = field.export(attr.expectedValue);
            }
            request.Expected[attr.attributeName] = expectedAttribute;
        }.bind(this));
    }
    log.silly('Built DELETE_ITEM request: ' + util.inspect(request, false, 5));

    // Make the request
    this.db.deleteItem(request, function(err, data){
        log.silly('DELETE_ITEM returned: err: ' + err + ', data: ' + util.inspect(data, false, 5));
        if(!d.rejectIfError(err)){
            return d.resolve(data);
        }
        else{
            log.error('DELETE_ITEM: ' + err.message + '\n' + err.stack);
        }
    }.bind(this));
    return d.promise;
};

var sortObjects = function(objects, values, property){
    property = property || 'id';

    var objectMap = {},
        i = 0;

    for(i=0; i < objects.length; i++){
        objectMap[objects[i][property]] = objects[i];
    }

    return values.map(function(value){
        return objectMap[value] || null;
    }).filter(function(o){
        return o !== null;
    });
};


// Accepts an array of objects
// Each object should look like this:
// {
//     'alias': 'url',
//     'hashes': [2134, 1234],
//     'ranges': [333333, 222222],
//     'attributesToGet': ['url']
// }
// alias is the table alias name
// hashes is an array of key-hashes of objects you want to get from this table
// ranges is an array of key-ranges of objects you want to get from this table
// only use ranges if this table has ranges in its key schema
// hashes and ranges must be the same length and have corresponding values
// attributesToGet is an array of the attributes you want returned for each
// object. Omit if you want the whole object.

// Example:
// To get the urls of songs 1, 2, and 3 and the entire love objects for
// love 98 with created value 1350490700640 and love 99 with 1350490700650:
// [
//     {
//         'alias': 'song',
//         'hashes': [1, 2, 3],
//         'attributesToGet': ['url']
//     },
//     {
//         'alias': 'loves',
//         'hashes': [98, 99],
//         'ranges': [1350490700640, 1350490700650]
//     },
// ]
Model.prototype.batchGet = function(req){
    log.debug('Batch get ' + util.inspect(req, false, 5));
    var d = when.defer(),
        request = {
            'RequestItems': {}
        },
        results = {},
        table,
        obj;

    // Assemble the request data
    req.forEach(function(item){
        table = this.table(item.alias);
        request.RequestItems[table.name] = {'Keys': []};
        // Add hashes
        item.hashes.forEach(function(hash){
            var hashKey = {'HashKeyElement': {}};
            hashKey.HashKeyElement[table.hashType] = hash.toString();
            request.RequestItems[table.name].Keys.push(hashKey);
        });

        // Add ranges
        if(item.ranges){
            item.ranges.forEach(function(range, index){
                request.RequestItems[table.name].Keys[index].RangeKeyElement = {};
                request.RequestItems[table.name].Keys[index].RangeKeyElement[table.rangeType] = range.toString();
            });
        }

        // Add attributesToGet
        if(item.attributesToGet){
            request.RequestItems[table.name].AttributesToGet = item.attributesToGet;
        }
    }.bind(this));

    log.silly('Built DELETE_ITEM request: ' + util.inspect(request, false, 5));

    // Make the request
    this.db.batchGetItem(request, function(err, data){
        log.silly('BATCH_GET returned: err: ' + err + ', data: ' + util.inspect(data, false, 5));
        if(!d.rejectIfError(err)){
            // translate the response from dynamo format to exfm format
            req.forEach(function(tableData){
                var table = this.table(tableData.alias),
                    schema = this.schema(tableData.alias),
                    items = data.Responses[table.name].Items;

                results[tableData.alias] = items.map(function(dynamoObj){
                    return schema.import(dynamoObj);
                }.bind(this));

                // Sort the results
                results[tableData.alias] = sortObjects(results[tableData.alias],
                    tableData.hashes, table.hashName);

            }.bind(this));
            d.resolve(results);
        }
        else{
            log.error('BATCH_GET: ' + err.message + '\n' + err.stack);
        }
    }.bind(this));
    return d.promise;
};


// this.batchWrite(
//     {
//         'song': [
//             {
//                 'id': 1,
//                 'title': 'Silence in a Sweater'
//             },
//             {
//                 'id': 2,
//                 'title': 'Silence in a Sweater (pt 2)'
//             },
//         ]
//     },
//     {
//         'song': [
//             {'id': 3}
//         ]
//     }
// );
Model.prototype.batchWrite = function(puts, deletes){
    log.debug('Batch write: puts`'+util.inspect(puts, false, 10)+'`, deletes`'+util.inspect(deletes, false, 10)+'` ');
    var d = when.defer(),
        self = this,
        req = {
            'RequestItems': {}
        },
        totalOps = 0;

    Object.keys(puts).forEach(function(alias){
        var table = this.table(alias),
            schema = this.schema(alias);
        if(!table){
            throw new Error('Dont know alias ' + alias);
        }

        if(!req.RequestItems.hasOwnProperty(table.name)){
            req.RequestItems[table.name] = [];
        }
        puts[alias].forEach(function(put){
            req.RequestItems[table.name].push({
                'PutRequest': {
                    'Item': schema.export(put)
                }
            });
            totalOps++;
        });
    }.bind(this));

    Object.keys(deletes).forEach(function(alias){
        var table = this.table(alias),
            schema = this.schema(alias);

        if(!req.RequestItems.hasOwnProperty(table.name)){
            req.RequestItems[table.name] = [];
        }

        deletes[alias].forEach(function(del){
            req.RequestItems[table.name].push({
                'DeleteRequest': {
                    'Key': schema.exportKey(del)
                }
            });
            totalOps++;
        });
    }.bind(this));

    if(totalOps > 25){
        throw new Error(totalOps + ' is too many for one batch!');
    }

    log.silly('Built BATCH_WRITE request: ' + util.inspect(req, false, 10));

    this.db.batchWriteItem(req, function(err, data){
        log.silly('BATCH_WRITE returned: err: ' + err + ', data: ' + util.inspect(data, false, 5));
        if(!d.rejectIfError(err)){
            var success = {};

            Object.keys(data.Responses).forEach(function(tableName){
                success[self.tableNameToAlias(tableName)] = data.Responses[tableName].ConsumedCapacityUnits;
            });

            d.resolve({'success': success,
                'unprocessed': data.UnprocessedItems});
        }
        else{
            log.error('BATCH_WRITE: ' + err.message + '\n' + err.stack);
        }
    });
    return d.promise;
};

// http://docs.amazonwebservices.com/amazondynamodb/latest/developerguide/API_PutItem.html

// alias: The table alias name

// obj: The object to put in the table. This method will handle formatting
// the object and casting.
// Sample:
// {
//     "url":"http://thissongexistsforreallzz.com/song1.mp3",
//     "id":30326673248,
//     "url_md5":"66496db3a1bbba45fb189030954e78d0",
//     "metadata_state":"pending",
//     "loved_count":0,
//     "listened":0,
//     "version":1,
//     "created":1350500174375
// }
//

// expected: See AWS docs for an explanation. This method handles casting
// and supplying the attribute types, so this object is somewhat simplified
// from what AWS accepts.
// Sample:
// {
//     'metadata_state': {'Value': 'pending', 'Exists': true},
//     'version': {'Value': 0, 'Exists': true}
// }
// returnValues: See AWS docs for an explanation.
Model.prototype.put = function(alias, obj, expected, returnOldValues){
    log.debug('Put `'+alias+'` '+ util.inspect(obj, false, 10));
    var d = when.defer(),
        table = this.table(alias),
        request,
        schema = this.schema(alias),
        clean = schema.export(obj);

    if(!table || !schema){
        throw new Error('Unknown alias ' + alias);
    }
    request = {'TableName': table.name, 'Item': schema.export(obj)};

    if(expected && Object.keys(expected).length > 0){
        request.Expected = {};
        Object.keys(expected).forEach(function(key){
            var field = schema.field(key);
            request.Expected[key] = {
                'Value': {}
            };
            request.Expected[key].Exists = expected[key].Exists;
            request.Expected[key].Value[field.type] = field.export(expected[key].Value);
        }.bind(this));
    }

    if(returnOldValues === true){
        request.ReturnValues = "ALL_OLD";
    }

    log.silly('Built PUT request: ' + util.inspect(request, false, 10));

    // Make the request
    this.db.putItem(request, function(err, data){
        log.silly('PUT returned: err: ' + err + ', data: ' + util.inspect(data, false, 5));
        if(!d.rejectIfError(err)){
            return d.resolve(obj);
        }
        else{
            log.error('PUT: ' + err.message + '\n' + err.stack);
        }
    });
    return d.promise;
};

// usage:
// update('alias', 'hash', [{
//      'attributeName': 'attribute_name'
//      'newValue': 'new_value',
//      'action': 'PUT'
//    }], {
//      'range': 'blahblah',
//      'expectedValues': [{
//          'attributeName': 'attribute_name',
//          'expectedValue': 'current_value', // optional
//          'exists': 'true' // defaults to true
//        }],
//      'returnValues':  'NONE'
//    })
Model.prototype.updateItem = function(alias, hash, attrs, opts){
    opts = opts || {};

    log.debug('Update `'+alias+'` with hash `'+hash+'` and range `'+opts.range+'`');
    log.debug(util.inspect(attrs, false, 5));

    var d = when.defer(),
        response = [],
        table = this.table(alias),
        schema = this.schema(alias),
        request = {
            'TableName': table.name,
            'Key': {},
            'AttributeUpdates': {},
            'ReturnValues': opts.returnValues || 'NONE'
        },
        obj,
        hashKey = {},
        rangeKey = {},
        expectedAttributes = {},
        expectedAttribute = {},
        attrSchema = this.table(alias).attributeSchema;

    // Add hash
    hashKey[table.hashType] = hash.toString();
    request.Key.HashKeyElement = hashKey;

    // Add range
    if(opts.range !== undefined){
        rangeKey[table.rangeType] = schema.field(schema.range).export(opts.range);
        request.Key.RangeKeyElement = rangeKey;
    }

    // Add attributeUpdates
    attrs.forEach(function(attr){
        // if(attr.attributeName != schema.hash && attr.attributeName != schema.range){
            var field = schema.field(attr.attributeName),
                attributeUpdate = {
                    'Value': {},
                    'Action': attr.action || 'PUT'
                };
            if(!field){
                throw new Error('Unknown field ' + attr.attributeName);
            }
            attributeUpdate.Value[field.type] = field.export(attr.newValue);
            request.AttributeUpdates[attr.attributeName] = attributeUpdate;
        // }
    }.bind(this));

    // Add expectedValues for conditional update
    if(opts.expectedValues !== undefined){
        request.Expected = {};
        opts.expectedValues.forEach(function(attr){
            var field = schema.field(attr.attributeName);
            expectedAttribute = {
                'Exists': Number(attr.exists).toString()
            };
            if (attr.expectedValue) {
                expectedAttribute.Value = {};
                expectedAttribute.Value[field.type] = field.export(attr.expectedValue);
            }

            request.Expected[attr.attributeName] = expectedAttribute;
        }.bind(this));
    }

    log.silly('Built UPDATE_ITEM request: ' + util.inspect(request, false, 10));

    // Make the request
    this.db.updateItem(request, function(err, data){
        log.silly('UPDATE_ITEM returned: err: ' + err + ', data: ' + util.inspect(data, false, 5));
        if(!d.rejectIfError(err)){
            if (opts.returnValues !== undefined) {
                return d.resolve(schema.import(data.Attributes));
            }
            return d.resolve(data);
        }
        else{
            log.error('UPDATE_ITEM: ' + err.message + '\n' + err.stack);
        }
    }.bind(this));
    return d.promise;
};

// usage:
// query('alias', 'hash', {
//     'limit': 2,
//     'consistentRead': true,
//     'scanIndexForward': true,
//     'rangeKeyCondition': {
//         'attributeValueList': [{
//             'attributeName': 'blhah',
//             'attributeValue': 'some_value'
//         }],
//         'comparisonOperator': 'GT'
//     },
//     'exclusiveStartKey': {
//         'hashName': 'some_hash',
//         'rangeName': 'some_range'
//     },
//     'attributeToGet':  ['attribute']
// })
Model.prototype.query = function(alias, hash, opts){
    opts = opts || {};

    log.debug('Query `'+alias+'` with hash `'+hash+'` and range `'+opts.range+'`');
    log.silly('Query options: ' + util.inspect(opts, false, 5));

    var d = when.defer(),
        response = [],
        table = this.table(alias),
        schema = this.schema(alias),
        request = {
            'TableName': table.name
        },
        obj,
        hashKey = {},
        rangeKey = {},
        attributeValueList = [],
        attributeValue = {},
        exclusiveStartKey = {},
        attrSchema = this.table(alias).attributeSchema,
        attr,
        dynamoType;

    // Add HashKeyValue
    hashKey[table.hashType] = hash.toString();
    request.HashKeyValue = hashKey;

    // Add RangeKeyCondition
    if(opts.rangeKeyCondition !== undefined){
        attributeValueList = opts.rangeKeyCondition.attributeValueList.map(function(attr){
            var field = schema.field(attr.attributeName);
            attributeValue = {};
            attributeValue[field.type] = field.export(attr.attributeValue);
            return attributeValue;
        });

        request.RangeKeyCondition = {
            'AttributeValueList': attributeValueList,
            'ComparisonOperator': opts.rangeKeyCondition.comparisonOperator
        };
    }

    // Add Limit
    if(opts.limit !== undefined){
        request.Limit = Number(opts.limit).toString();
    }

    // Add ConsistentRead
    if(opts.consistentRead){
        request.ConsistentRead = Number(opts.consistentRead).toString();
    }

    // Add ScanIndexForward
    if(opts.scanIndexForward !== undefined){
        request.ScanIndexForward = Number(opts.scanIndexForward).toString();
    }

    // Add ExclusiveStartKey
    if(opts.exclusiveStartKey !== undefined){
        hashKey[table.hashType] = opts.exclusiveStartKey.hashName.toString();
        request.ExclusiveStartKey.HashKeyElement = hashKey;
        if(opts.exclusiveStartKey.range !== undefined){
            rangeKey[table.rangeType] = opts.exclusiveStartKey.rangeName.toString();
            request.ExclusiveStartKey.RangeKeyElement = rangeKey;
        }
    }

    // Add AttributesToGet
    if(opts.attributesToGet !== undefined){
        request.AttributesToGet = opts.attributesToGet;
    }

    log.silly('Built QUERY request: ' + util.inspect(request, false, 10));

    // Make the request
    this.db.query(request, function(err, data){
        log.silly('QUERY returned: err: ' + err + ', data: ' + util.inspect(data, false, 5));
        if(!d.rejectIfError(err)){
            var items = data.Items.map(function(item){
                return schema.import(item);
            }.bind(this));
            return d.resolve(items);
        }
        else{
            log.error('QUERY: ' + err.message + '\n' + err.stack);
        }
    }.bind(this));
    return d.promise;
};


// # DANGER: THIS WILL DROP YOUR TABLES AND SHOULD ONLY BE USED IN TESTING.
Model.prototype.recreateTable = function(alias) {
    var d = when.defer(),
        table = this.table(alias),
        tableRequest = {
            'TableName': table.name
        },
        tableDescription = {};

    // if (process.env.NODE_ENV !== 'testing') {
    //     throw new Error('Can only recreate a table in testing environment');
    // }
    sequence(this).then(function(next){
        this.db.describeTable(tableRequest, function(err, data){
            if (!err) {
                next(data);
            }
            else {
                throw new Error(err);
            }
        });
    }).then(function(next, data){
        tableDescription = data;
        this.db.deleteTable(tableRequest, function(err, data){
            if (!err) {
                next(data);
            }
            else {
                throw new Error(err);
            }
        });
    }).then(function(next, data){
        tableRequest.KeySchema = tableDescription.Table.KeySchema;
        tableRequest.ProvisionedThroughput = tableDescription.Table.ProvisionedThroughput;
        this.isTableDeleted(table.name).then(next);

    }).then(function(next){
        this.db.createTable(tableRequest, function(err, data){
            if (!err) {
                return next(data);
            }
            else {
                throw new Error(err);
            }
        });
    }).then(function(next, data){
        this.isTableActive(table.name).then(function(){
            d.resolve(true);
        });
    });
    return d.promise;
};

Model.prototype.isTableDeleted = function(tableName){
    var d = when.defer(),
        self = this;
    this.db.describeTable({
        'TableName': tableName
    }, function(err, data){
        if (data === undefined) {
            return d.resolve(true);
        }
        else {
            setTimeout(function(){
                self.isTableDeleted(tableName).then(function(_){
                    d.resolve(_);
                });
            }, 5000);
        }
    });
    return d.promise;
};

Model.prototype.isTableActive = function(tableName){
    var d = when.defer(),
        self = this;
    this.db.describeTable({
        'TableName': tableName
    }, function(err, data){
        if (data.Table.TableStatus === 'ACTIVE') {
            return d.resolve(true);
        }
        else {
            setTimeout(function(){
                self.isTableActive(tableName).then(function(_){
                    d.resolve(_);
                });
            }, 5000);
        }
    });
    return d.promise;
};

module.exports.Model = Model;
module.exports.Schema = Schema;
Object.keys(fields).forEach(function(fieldName){
    module.exports[fieldName] = fields[fieldName];
});
