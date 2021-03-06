import { helper } from '@ember/component/helper';

// TODO - This should really be part of the Card's API, not a front-end helper

export default helper(function catalogFieldIcon([title]) {
  const iconMap = [
    {
      title: 'Text',
      icon: 'string-field-icon',
    },
    {
      title: 'Checkbox',
      icon: 'boolean-field-icon',
    },
    {
      title: 'Number',
      icon: 'integer-field-icon',
    },
    {
      title: 'Date',
      icon: 'date-field-icon',
    },
    {
      title: 'Date-time',
      icon: 'date-field-icon',
    },
    {
      title: 'Link',
      icon: 'link-field-icon',
    },
    {
      title: 'Image',
      icon: 'image-field-icon',
    },
    {
      title: 'Image from relative URL',
      icon: 'image-field-icon',
    },
    {
      title: 'Button link',
      icon: 'cta-field-icon',
    },
    {
      title: 'Base Card',
      icon: 'has-many-field-icon',
    },
  ];

  let matched = iconMap.find(field => {
    return field.title === title;
  });

  if (matched) {
    return matched.icon;
  } else {
    // Default to base-card icon if there's no match.
    // svg-jar errors if no svg is provided.
    return 'has-many-field-icon';
  }
});
