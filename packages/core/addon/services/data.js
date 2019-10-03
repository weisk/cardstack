import Service from '@ember/service';
import { get, set, uniqBy, merge, cloneDeep } from 'lodash';
import { hubURL } from '@cardstack/plugin-utils/environment';
import { inject as service } from '@ember/service';
import { tracked } from '@glimmer/tracking';
import { assert } from '@ember/debug';

let priv = new WeakMap();
let store = {
  isolated: new Map(),
  embedded: new Map()
}

export default class DataService extends Service {
  @service cardstackSession;

  async getCard(id, format) {
    if (!['isolated', 'embedded'].includes(format)) { throw new Error(`unknown format specified when getting card '${id}': '${format}'`); }

    if (store[format].has(id)) {
      return new Card({
        id,
        format,
        session: this.cardstackSession,
        data: await store[format].get(id)
      });
    } else {
      let card = new Card({
        id,
        format,
        session: this.cardstackSession,
      });
      return await card.load(format);
    }
  }

  createCard(id) {
    return new Card({
      id,
      format: 'isolated',
      isNew: true,
      session: this.cardstackSession
    });
  }

  // used for tests
  _clearCache() {
    store.isolated = new Map();
    store.embedded = new Map();
  }
}

class Card {
  constructor({
    id,
    format = 'embedded',
    isNew = false,
    session,
    data
  }) {
    // this keeps our internal state private
    priv.set(this, new CardInternals({
      id,
      isDestroyed: false,
      session,
      isNew,
      format,
      isDirty: isNew || false,
      isLoaded: Boolean(data),
      serverEmbeddedData: (format === 'embedded' ? data : null) ||
      { data: { id, type: 'cards' } },
      serverIsolatedData: (format === 'isolated' ? data : null) ||
      {
        data: {
          id,
          type: 'cards',
          relationships: {
            fields: {
              data: [],
            },
            model: {
              data: { type: id, id }
            }
          }
        },
        included: [
          { id, type: id }
        ]
      }
    }));

    reifyFieldsFromCardMetadata(this);
  }

  toString() {
    return `<card ${this.id}>`;
  }

  get id() {
    return priv.get(this).id;
  }

  get format() {
    if (this.isDestroyed) { throw new Error('Cannot get format from destroyed card'); }
    return priv.get(this).format;
  }

  get isNew() {
    if (this.isDestroyed) { throw new Error('Cannot get isNew from destroyed card'); }
    return priv.get(this).isNew;
  }

  get isDirty() {
    if (this.isDestroyed) { throw new Error('Cannot get isDirty from destroyed card'); }
    return priv.get(this).isDirty;
  }

  // This is used to know if the caller needs to .load() the
  // card first (in the case the card was retrieved by
  // following a relationship that is was not included
  // in the related card's document)
  get isLoaded() {
    if (this.isDestroyed) { throw new Error('Cannot get isLoaded from destroyed card'); }
    return priv.get(this).isLoaded;
  }

  get isDestroyed() {
    return priv.get(this).isDestroyed;
  }

  get json() {
    if (this.isDestroyed) { throw new Error('Cannot get json from destroyed card'); }
    return getCardDocument(this);
  }

  get fields() {
    if (this.isDestroyed) { throw new Error('Cannot get fields from destroyed card'); } // TODO test this
    return priv.get(this).fields;
  }

  getField(fieldName) {
    if (this.isDestroyed) { throw new Error('Cannot call getField from destroyed card'); }
    let internal = priv.get(this);
    return (internal.fields || []).find(i => i.name === fieldName);
  }

  addField({ name, type, neededWhenEmbedded=false, value }) {
    if (this.isDestroyed) { throw new Error('Cannot addField from destroyed card'); }
    if (this.format === 'embedded') { throw new Error(`Cannot addField() on card id '${this.id}' because the card is in the embedded format. Use load('isolated') to get the isolated form of the card before adding fields.`) }
    if (!name) { throw new Error(`'addField()' called for card id '${this.id}' is missing 'name'`); }
    if (!type) { throw new Error(`'addField()' called for card id '${this.id}' is missing 'type'`); }
    if (this.fields.find(i => i.name === name)) { throw new Error(`'addField() called for card id '${this.id}' to add a new field 'fields/${name}' which already exists for this card.`); }

    let field = new Field({ card: this, name, type, neededWhenEmbedded, value });
    let internal = priv.get(this);
    internal.fields.push(field);
    // eslint-disable-next-line no-self-assign
    internal.fields = internal.fields; // oh glimmer, you so silly...
    internal.isDirty = true;
    return field;
  }

  moveField(/*field, position*/) {
    if (this.isDestroyed) { throw new Error('Cannot moveField from destroyed card'); }
    if (this.format === 'embedded') { throw new Error(`Cannot moveField() on card id '${this.id}' because the card is in the embedded format. Use load('isolated') to get the isolated form of the card before moving the field.`) }
    // TODO
  }

  async save() {
    if (this.isDestroyed) { throw new Error('Cannot save from destroyed card'); }
    if (this.format === 'embedded') { throw new Error(`Cannot save card id '${this.id}' because the card is in the embedded format. Use load('isolated') to get the isolated form of the card.`) }
    if (!this.isDirty) { return this; }

    let internal = priv.get(this);
    store.isolated.set(this.id, this._saveCard());
    internal.serverIsolatedData = await store.isolated.get(this.id);
    for (let card of (internal.serverIsolatedData.included || []).filter(i => i.type === 'cards')) {
      store.embedded.set(card.id, new Promise(res => res({ data: card })));
    }

    reifyFieldsFromCardMetadata(this);
    internal.isNew = false;
    internal.isDirty = false;
    internal.isLoaded = true;

    return this;
  }

  async load(format = 'isolated') {
    if (this.isDestroyed) { throw new Error('Cannot load from destroyed card'); }
    if (!['isolated', 'embedded'].includes(format)) { throw new Error(`unknown format specified in 'load()' for card '${this.id}': '${format}'`); }

    let internal = priv.get(this);
    internal.format = format;
    let response = await fetch(`${hubURL}/api/cards/${this.id}?format=${format}`, {
      headers: {
        'Content-Type': 'application/vnd.api+json',
        'Authorization': `Bearer ${internal.session.token}`
      },
    });
    if (response.ok) {
      store[format].set(this.id, response.json());
      if (format === 'isolated') {
        internal.serverIsolatedData = await store[format].get(this.id);
        for (let card of (internal.serverIsolatedData.included || []).filter(i => i.type === 'cards')) {
          store.embedded.set(card.id, new Promise(res => res({ data: card })));
        }
      } else {
        internal.serverEmbeddedData = await store[format].get(this.id);
        for (let card of (internal.serverEmbeddedData.included || []).filter(i => i.type === 'cards')) {
          store.embedded.set(card.id, new Promise(res => res({ data: card })));
        }
      }

      reifyFieldsFromCardMetadata(this);
      internal.isLoaded = true;

      return this;
    } else {
      let error = await response.json();
      throw new Error(`Cannot load card ${response.status}: ${response.statusText}`, error);
    }
  }

  async delete() {
    if (this.isDestroyed) { throw new Error('Cannot delete from destroyed card'); }
    let version = get(this.json, 'data.meta.version');
    if (version == null) {
      await this.load('embedded');
      version = get(this.json, 'data.meta.version');
      if (version == null) {
        throw new Error(`cannot determine version of card '${this.id}'`);
      }
    }

    let internal = priv.get(this);
    let response = await fetch(`${hubURL}/api/cards/${this.id}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/vnd.api+json',
        'Authorization': `Bearer ${internal.session.token}`,
        'If-Match': version,
      },
    });
    if (!response.ok) {
      let error = await response.json();
      throw new Error(`Cannot delete card ${response.status}: ${response.statusText}`, error);
    }
    for (let field of this.fields) {
      priv.get(field).isDestroyed = true;
    }
    internal.isDestroyed = true;
    store.isolated.delete(this.id);
    store.embedded.delete(this.id);
  }

  async _saveCard() {
    if (this.isDestroyed) { throw new Error('Cannot _saveCard from destroyed card'); }
    let { session } = priv.get(this);
    let url = this.isNew ? `${hubURL}/api/cards` : `${hubURL}/api/cards/${this.id}`;
    let response = await fetch(url, {
      method: this.isNew ? 'POST' : 'PATCH',
      headers: {
        'Content-Type': 'application/vnd.api+json',
        'Authorization': `Bearer ${session.token}`
      },
      body: JSON.stringify(this.json)
    });

    let json = await response.json();

    if (!response.ok) {
      throw new Error(`Cannot create card ${response.status}: ${response.statusText}`, json);
    }

    return json;
  }
}

// Note this Field class is only used to represent metadata fields.
// Internal card fields (fields not exposed as metadata) are intentionally
// not exposed by this API--maybe we decide to change that in the future...
class Field {
  constructor({
    card,
    name,
    type,
    neededWhenEmbedded,
    value
  }) {
    // this keeps our internal state private
    priv.set(this, new FieldInternals({
      card,
      name,
      type,
      neededWhenEmbedded,
      value
    }));
  }

  toString() {
    let internal = priv.get(this); // using field internals so we can call toString even after Field is destroyed
    return `<field ${internal.name} (of ${internal.card})>`;
  }

  get card() {
    if (this.isDestroyed) { throw new Error('Cannot get card from destroyed field'); }
    return priv.get(this).card;
  }

  get name() {
    if (this.isDestroyed) { throw new Error('Cannot get name from destroyed field'); }
    return priv.get(this).name;
  }

  get type() {
    if (this.isDestroyed) { throw new Error('Cannot get type from destroyed field'); }
    return priv.get(this).type;
  }

  get neededWhenEmbedded() {
    if (this.isDestroyed) { throw new Error('Cannot get neededWhenEmbedded from destroyed field'); }
    return priv.get(this).neededWhenEmbedded;
  }

  get value() {
    if (this.isDestroyed) { throw new Error('Cannot get value from destroyed field'); }
    return priv.get(this).value;
  }

  get isDestroyed() {
    return priv.get(this).isDestroyed;
  }

  get json() {
    if (this.isDestroyed) { throw new Error('Cannot get json from destroyed field'); }
    let { name:id, type, neededWhenEmbedded, serverData } = priv.get(this);
    // We're returning a JSON:API document here (as opposed to a resource) since eventually
    // a field may encapsulate constraints as included resources within its document
    return {
      data: merge(cloneDeep(serverData) || {}, {
        id,
        type: 'fields',
        attributes: {
          'is-metadata': true,
          'needed-when-embedded': neededWhenEmbedded,
          'field-type': type
        }
      })
    };
  }

  setValue(value) {
    if (this.isDestroyed) { throw new Error('Cannot setValue from destroyed field'); }
    if (this.card.format === 'embedded') { throw new Error(`Cannot setValue() on card '${this.card.id}', field '${this.name}' because the card is in the embedded format. Use card.load('isolated') to get the isolated form of the card before setting field values.`) }

    let internal = priv.get(this);
    let internalCard = priv.get(this.card);

    // Note that the only kind of relationships that you can fashion are to other cards
    if (this.type === '@cardstack/core-types::belongs-to') {
      if (!(value instanceof Card)) {
        value = new Card({ id: value, format: 'embedded', session: internalCard.session });
      }
      internal.value = value;
    } else if (this.type === '@cardstack/core-types::has-many') {
      if (!Array.isArray(value)) { throw new Error(`Cannot set cards relationships on card id '${this.card.id}', field '${this.name}' from value '${JSON.stringify(value)}'. The value must be an array of Cards.`); }

      value = [].concat(value.map(i => !(i instanceof Card) ? new Card({ id: i, format: 'embedded', session: internalCard.session }) : i));
      internal.value = value;
    } else {
      internal.value = value;
    }
    internalCard.isDirty = true;
  }

  remove() {
    if (this.isDestroyed) { throw new Error('Cannot removeField from destroyed field'); }
    if (this.card.format === 'embedded') { throw new Error(`Cannot removeField() on card id '${this.id}', field '${this.name}' because the card is in the embedded format. Use card.load('isolated') to get the isolated form of the card before removing the field.`) }

    let internal = priv.get(this);
    let internalCard = priv.get(this.card);

    internalCard.fields = internalCard.fields.filter(i => i.name !== this.name);
    internalCard.serverIsolatedData.included = (internalCard.serverIsolatedData.included || []).filter(i => `${i.type}/${i.id}` !== `fields/${this.name}`);
    // eslint-disable-next-line no-self-assign
    internal.serverIsolatedData = internal.serverIsolatedData; // oh glimmer, you so silly...
    internalCard.isDirty = true;
    internal.isDestroyed = true;
  }

  // TODO
  setNeededWhenEmbedded(/*neededWhenEmbedded*/) {
    if (this.isDestroyed) { throw new Error('Cannot setNeededWhenEmbedded from destroyed field'); }
  }
}

// Our internal state does need to be tracked so that glimmer can rerender
// as it changes, hence this class "bucket-o-state"
class CardInternals {
  @tracked id;
  @tracked isDestroyed;
  @tracked session;
  @tracked isNew;
  @tracked format;
  @tracked isDirty;
  @tracked isLoaded;
  @tracked serverEmbeddedData;
  @tracked serverIsolatedData;
  @tracked fields;

  constructor({
    id,
    session,
    isNew,
    format,
    isDirty,
    isLoaded,
    fields=[],
    serverEmbeddedData,
    serverIsolatedData,
  }) {
    this.id = id;
    this.session = session;
    this.isNew = isNew;
    this.format = format;
    this.isDirty = isDirty;
    this.isLoaded = isLoaded;
    this.serverEmbeddedData = serverEmbeddedData;
    this.serverIsolatedData = serverIsolatedData;
    this.isDestroyed = false;
    this.fields = fields;
  }
}

class FieldInternals {
  @tracked card;
  @tracked name;
  @tracked type;
  @tracked neededWhenEmbedded;
  @tracked value;
  @tracked serverData;
  @tracked isDestroyed;
  // TODO add contraints and "related cards" capabilities

  constructor({
    card,
    name,
    type,
    neededWhenEmbedded,
    value,
    serverData
  }) {
    this.card = card;
    this.name = name;
    this.type = type;
    this.neededWhenEmbedded = neededWhenEmbedded;
    this.value = value;
    this.serverData = serverData;
    this.isDestroyed = false;
  }
}

function getCardDocument(card) {
  let { id, serverEmbeddedData, serverIsolatedData, fields, format } = priv.get(card);
  let doc = cloneDeep((format === 'isolated' ? serverIsolatedData : serverEmbeddedData));
  let modelAttributes = {};
  let modelRelationships = {};

  for (let field of fields) {
    if (field.value === undefined) { continue; }
    if (['@cardstack/core-types::belongs-to', '@cardstack/core-types::has-many'].includes(field.type)) {
      modelRelationships[field.name] = {
        data: field.type.includes('has-many') ?
        (field.value || []).map(i => ({ type: 'cards', id: i.id })) :
        (field.value ? { type: 'cards', id: field.value.id } : null)
      }
    } else {
      modelAttributes[field.name] = field.value;
    }
  }

  set(doc, `data.relationships.fields.data`, fields.map(i => ({ type: 'fields', id: i.name })));
  if (format === 'isolated') {
    let modelIndex = doc.included.findIndex(i => `${i.type}/${i.id}` === `${id}/${id}`);
    if (Object.keys(modelAttributes).length) {
      set(doc, `included[${modelIndex}].attributes`, modelAttributes);
    }
    if (Object.keys(modelRelationships).length) {
      set(doc, `included[${modelIndex}].relationships`, modelRelationships);
    }
    doc.included = uniqBy(doc.included.concat(fields.map(i => i.json.data)), i => `${i.type}/${i.id}`);
  }

  return doc;
}

function getCardMetadata(card, type, fieldName) {
  let { session } = priv.get(card);
  if (type === '@cardstack/core-types::has-many') {
    let refs = get(card.json, `data.relationships.${fieldName}.data`) || [];
    return refs.map(({ id }) => {
      let embeddedCard = (card.json.included || []).find(i => `${i.type}/${i.id}` === `cards/${id}`);
      return new Card({
        id,
        format: 'embedded',
        session: session,
        data: embeddedCard ? { data: embeddedCard } : null
      });
    });
  } else if (type === '@cardstack/core-types::belongs-to') {
    let { id } = get(card.json, `data.relationships.${fieldName}.data`) || {};
    let embeddedCard = (card.json.included || []).find(i => `${i.type}/${i.id}` === `cards/${id}`);
    return id ? new Card({
      id,
      format: 'embedded',
      session: session,
      data: embeddedCard ? { data: embeddedCard } : null
    }) : undefined;
  } else {
    return get(card.json, `data.attributes.${fieldName}`);
  }
}

function reifyFieldsFromCardMetadata(card) {
  let fields = [];
  let fieldTypes = get(card.json, 'data.attributes.metadata-field-types') || {};
  for (let name of Object.keys(fieldTypes)) {
    let neededWhenEmbedded;
    if (card.format === 'isolated') {
      let fieldResource = (card.json.included || []).find(i => `${i.type}/${i.id}` === `fields/${name}`);
      assert(`card '${card.id}' is missing included resource 'fields/${name}' in the card document for the isolated format`, fieldResource);
      neededWhenEmbedded = get(fieldResource, 'attributes.needed-when-embedded');
    } else {
      neededWhenEmbedded = true; // the only reason you are seeing this field is because it is needed-when-embedded
    }
    let type = fieldTypes[name];
    let value = getCardMetadata(card, type, name);
    fields.push(new Field({ card: card, name, type, neededWhenEmbedded, value }));
  }
  priv.get(card).fields = fields;
}