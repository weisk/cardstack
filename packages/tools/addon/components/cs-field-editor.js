import Component from '@ember/component';
import { not } from '@ember/object/computed';
import { computed } from '@ember/object';
import layout from '../templates/components/cs-field-editor';

export default Component.extend({
  layout,
  tagName: '',

  // @args
  content: null,
  field: '',
  enabled: true,
  errors: null,

  disabled: computed('enabled', 'canUpdate', function() {
    return !(this.enabled && this.canUpdate);
  }),

  firstError: computed('errors.[]', function() {
    return this.errors && this.errors[0];
  })
});
