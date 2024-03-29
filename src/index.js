module.exports = createFirebaseAuthSource;

const LIMIT = 200;

function createFirebaseAuthSource({ auth }) {
    return async function loadCollection() {
        return {
            find,
            list,
            create,
            upsert,
            update,
            delete: remove
        };

        async function create(id, data) {
            const user = await auth.createUser({
                uid: id,
                ...data
            });
            return user.uid;
        }

        async function upsert(id, data) {
            const user = await find(id);
            if (user) {
                await update(id, data);
            } else {
                await create(id, data);
            }
            return id;
        }

        async function update(id, data) {
            await auth.updateUser(id, data);
        }

        async function remove(id) {
            await auth.deleteUser(id);
        }

        async function find(id) {
            try {
                const user = await auth.getUser(id);
                return user;
            } catch (ex) {
                if (ex.code === `auth/user-not-found`) {
                    return undefined;
                } else {
                    throw ex;
                }
            }
        }

        async function list({ filter, order, first, last, before, after }) {
            if (first < 0) {
                throw new Error(`When supplied, first MUST be greater than or equal to 0`);
            }
            if (last < 0) {
                throw new Error(`When supplied, last MUST be greater than or equal to 0`);
            }
            if (before) {
                throw new Error(`firebase auth list does not support the before cursor`);
            }
            if (first === 0 || last === 0) {
                return empty();
            }
            if (first > 0 && last > 0 && first > last) {
                // This just simplifies the conditions later
                last = undefined;
            }
            if (first > 0 === false && last > 0 || last > first) {
                throw new Error(`firebase auth list does not support accessing data from the tail`);
            }
            if (order && order.length) {
                throw new Error(`Auth service user listing does not support ordering`);
            }

            const limit = calculateLimit();
            if (limit > LIMIT) {
                throw new Error(`The maximum number of records that can be requested (using first and last) ` +
                    `is ${LIMIT}. Received ${limit} (first: ${first}. last: ${last})`);
            }

            if (after) {
                after = deserializeCursor(after);
            }
            if (after && after.field || filter && filter.length) {
                return pseudoList(after);
            } else {
                return standardList(after);
            }

            async function standardList(cursor) {
                let lim = limit;
                if (cursor && cursor.offset > 0) {
                    lim = lim + cursor.offset;
                }
                const listResult = await auth.listUsers(lim, cursor && cursor.list);
                const users = [];
                listResult.users.forEach(user => users.push(user));

                // Remove any from the offset
                if (cursor && cursor.offset > 0) {
                    for (var userIndex = 0; userIndex < cursor.offset; userIndex++) {
                        users[userIndex] = false;
                    }
                }
                return buildResult(users);

                function buildResult(users) {
                    if (users) {
                        return {
                            edges: users
                                .map(buildEdge)
                                .filter(e => e),
                            pageInfo: {
                                hasPreviousPage: Boolean(cursor),
                                hasNextPage: Boolean(listResult.pageToken)
                            }
                        };
                    } else {
                        return empty();
                    }

                    function buildEdge(user, index) {
                        if (user) {
                            const edgeCursor = index === users.length - 1 && listResult.pageToken ?
                                serializeCursor({ list: listResult.pageToken, offset: 0 }) :
                                serializeCursor({ list: cursor && cursor.list, offset: index + 1 });
                            return {
                                node: {
                                    uid: user.uid,
                                    email: user.email,
                                    emailVerified: user.emailVerified,
                                    phoneNumber: user.phoneNumber,
                                    disabled: user.disabled
                                },
                                cursor: edgeCursor
                            };
                        } else {
                            return undefined;
                        }
                    }
                }
            }

            async function pseudoList(cursor) {
                filter.forEach(validateFieldOperation);
                let current, users;

                if (cursor) {
                    users = [await lookup(cursor.field, cursor.value)];
                } else {
                    current = filter.shift();
                    users = [await lookup(current.field, current.value)];
                }

                // If we have additional, make sure all filters match the user
                while (filter.length && users.length) {
                    current = filter.shift();
                    users = users.filter(user => user[current.field] === current.value);
                }
                return buildResult(users);

                async function lookup(field, value) {
                    let user;
                    switch (field) {
                        case `uid`:
                            user = await find(value);
                            break;
                        case `email`:
                            user = await findByEmail(value);
                            break;
                        case `phoneNumber`:
                            user = await findByPhoneNumber(value);
                            break;
                        default:
                            throw new Error(`Filtering on "${field}" not supported`);
                    }
                    return user;
                }

                function buildResult(users) {
                    if (users) {
                        return {
                            edges: users.map(buildEdge),
                            pageInfo: {
                                hasPreviousPage: false,
                                hasNextPage: false
                            }
                        };
                    } else {
                        return empty();
                    }

                    function buildEdge(user) {
                        // TODO: Can we avoid building the cursor based on requested fields?
                        return {
                            node: {
                                uid: user.uid,
                                email: user.email,
                                emailVerified: user.emailVerified,
                                phoneNumber: user.phoneNumber,
                                disabled: user.disabled
                            },
                            cursor: serializeCursor({ field: `uid`, value: user.uid })
                        };
                    }
                }

                function validateFieldOperation(filter) {
                    if (filter.op !== `EQ`) {
                        throw new Error(`Filter operations on users only support comparison (equals) operations`);
                    }
                }
            }

            function empty() {
                return {
                    edges: [],
                    pageInfo: {
                        hasPreviousPage: false,
                        hasNextPage: false
                    }
                };
            }

            function calculateLimit() {
                if (first >=0 && last >= 0) {
                    return Math.max(first, last);
                } else if (first >= 0) {
                    return first;
                } else if (last >= 0) {
                    return last;
                } else {
                    return LIMIT;
                }
            }
        }

        async function findByEmail(email) {
            try {
                const user = await auth.getUserByEmail(email);
                return user;
            } catch (ex) {
                if (ex.code === `auth/user-not-found`) {
                    return undefined;
                } else {
                    throw ex;
                }
            }
        }

        async function findByPhoneNumber(phoneNumber) {
            try {
                const user = await auth.getUserByPhoneNumber(phoneNumber);
                return user;
            } catch (ex) {
                if (ex.code === `auth/user-not-found`) {
                    return undefined;
                } else {
                    throw ex;
                }
            }
        }
    };

    function serializeCursor({ field, value, list, offset }) {
        const data = { f: field, v: value, l: list, o: offset };
        return Buffer.from(JSON.stringify(data)).toString(`base64`);
    }

    function deserializeCursor(cursor) {
        const buffer = Buffer.from(cursor, `base64`);
        const data = JSON.parse(buffer.toString(`utf8`));
        return {
            field: data.f,
            value: data.v,
            list: data.l,
            offset: data.o
        };
    }
}
