(function attachSidepanelEditableListPicker(globalScope) {
  const editableListPickers = [];

  function splitEditableListValues(value = '') {
    return String(value || '')
      .split(/[\r\n,，、]+/)
      .map((name) => name.trim())
      .filter(Boolean);
  }

  function normalizeEditableListValues(...sources) {
    const values = [];
    const seen = new Set();

    const append = (value) => {
      if (Array.isArray(value)) {
        value.forEach(append);
        return;
      }
      for (const item of splitEditableListValues(value)) {
        const key = item.toLowerCase();
        if (!key || seen.has(key)) {
          continue;
        }
        seen.add(key);
        values.push(item);
      }
    };

    sources.forEach(append);
    return values;
  }

  function createEditableListPicker(config = {}) {
    const {
      root,
      input,
      trigger,
      current,
      menu,
      emptyLabel = '请先添加',
      fallbackItems = [],
      minItems = 0,
      deleteLabel = '删除',
      itemLabel = '项目',
      multiSelect = false,
      multiSelectJoiner = ', ',
      multiSelectEmptyLabel = null,
      formatMultiSelectSummary = null,
      multiSelectMaxLabelLength = 36,
      normalizeItems = normalizeEditableListValues,
      normalizeValue = (value) => String(value || '').trim(),
      getItemValue = (item) => String(item || '').trim(),
      getItemLabel = (item) => getItemValue(item),
      getItemDeleteLabel = (item) => getItemLabel(item),
      onDelete = null,
      onDeleteError = null,
    } = config;

    const picker = {
      root,
      input,
      trigger,
      current,
      menu,
      items: [],
      open: false,
      multiSelect: Boolean(multiSelect),
    };

    const getFallbackItems = () => normalizeItems(fallbackItems);
    const getNormalizedItemValue = (item) => normalizeValue(getItemValue(item));
    const findItemByValue = (value) => {
      const normalized = normalizeValue(value);
      return picker.items.find((item) => getNormalizedItemValue(item) === normalized) || null;
    };
    const reportDeleteError = (error) => {
      const fallbackMessage = `${deleteLabel}${itemLabel}失败。`;
      if (typeof onDeleteError === 'function') {
        onDeleteError(error, fallbackMessage);
        return;
      }
      if (typeof globalScope.showToast === 'function') {
        globalScope.showToast(error?.message || fallbackMessage, 'error');
      }
    };

    function parseMultiSelectValues(value) {
      if (Array.isArray(value)) {
        return normalizeEditableListValues(value).map(normalizeValue).filter(Boolean);
      }
      return splitEditableListValues(String(value || '')).map(normalizeValue).filter(Boolean);
    }

    function dedupeKeepingOrder(values = []) {
      const seen = new Set();
      const result = [];
      for (const value of values) {
        const key = String(value || '').toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        result.push(value);
      }
      return result;
    }

    function getKnownItemValueByCaseInsensitive(value) {
      const key = String(value || '').toLowerCase();
      const match = picker.items.find((item) => getNormalizedItemValue(item).toLowerCase() === key);
      return match ? getNormalizedItemValue(match) : value;
    }

    function getMultiSelectSelectedValues() {
      const raw = parseMultiSelectValues(input?.value);
      return dedupeKeepingOrder(raw.map(getKnownItemValueByCaseInsensitive));
    }

    function getMultiSelectDisplayLabel(selectedValues = []) {
      if (!selectedValues.length) {
        return multiSelectEmptyLabel || emptyLabel;
      }
      if (typeof formatMultiSelectSummary === 'function') {
        const custom = formatMultiSelectSummary(selectedValues, picker.items);
        if (custom) return custom;
      }
      const labels = selectedValues.map((value) => {
        const matched = findItemByValue(value);
        return matched ? getItemLabel(matched) : value;
      });
      const joined = labels.join(multiSelectJoiner);
      if (multiSelectMaxLabelLength > 0 && joined.length > multiSelectMaxLabelLength) {
        return `已选 ${labels.length} 个${itemLabel}`;
      }
      return joined;
    }

    picker.setOpen = (open) => {
      picker.open = Boolean(open) && !trigger?.disabled;
      if (menu) {
        menu.hidden = !picker.open;
      }
      if (trigger) {
        trigger.setAttribute('aria-expanded', picker.open ? 'true' : 'false');
        trigger.classList?.toggle('is-open', picker.open);
      }
    };

    picker.close = () => {
      picker.setOpen(false);
    };

    picker.setVisible = (visible) => {
      if (root) {
        root.style.display = visible ? '' : 'none';
      }
      if (!visible) {
        picker.close();
      }
    };

    picker.setSelection = (value, options = {}) => {
      if (picker.multiSelect) {
        const incoming = parseMultiSelectValues(value);
        const selectedValues = dedupeKeepingOrder(incoming.map(getKnownItemValueByCaseInsensitive));
        const joined = selectedValues.join(multiSelectJoiner);
        if (input) {
          if (input.value !== joined) {
            input.value = joined;
          }
          if (options.emit && typeof input.dispatchEvent === 'function') {
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
        if (current) {
          current.textContent = getMultiSelectDisplayLabel(selectedValues);
        }
        return;
      }

      const fallback = getNormalizedItemValue(picker.items[0]) || getNormalizedItemValue(getFallbackItems()[0]) || '';
      const selected = normalizeValue(value) || fallback;
      const selectedItem = findItemByValue(selected);
      if (input) {
        input.value = selected;
        if (options.emit && typeof input.dispatchEvent === 'function') {
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      if (current) {
        current.textContent = selectedItem ? getItemLabel(selectedItem) : (selected || emptyLabel);
      }
    };

    function toggleMultiSelectValue(itemValue, options = {}) {
      const currentValues = getMultiSelectSelectedValues();
      const key = String(itemValue || '').toLowerCase();
      const exists = currentValues.some((value) => String(value || '').toLowerCase() === key);
      const next = exists
        ? currentValues.filter((value) => String(value || '').toLowerCase() !== key)
        : [...currentValues, itemValue];
      picker.setSelection(next, { emit: true });
      if (options.rerender) {
        renderOptions(next);
      }
    }

    function renderOptions(selectedValues) {
      if (!menu || typeof menu.appendChild !== 'function') {
        return;
      }
      const multiSelectedList = picker.multiSelect
        ? (Array.isArray(selectedValues)
          ? selectedValues
          : (selectedValues != null && selectedValues !== ''
            ? parseMultiSelectValues(selectedValues)
            : getMultiSelectSelectedValues()))
        : [];
      const selectedSet = picker.multiSelect
        ? new Set(multiSelectedList.map((value) => String(value || '').toLowerCase()))
        : null;
      const singleSelected = picker.multiSelect ? '' : String(selectedValues || '');
      menu.innerHTML = '';
      picker.items.forEach((item) => {
        const itemValue = getNormalizedItemValue(item);
        const isSelected = picker.multiSelect
          ? selectedSet.has(String(itemValue || '').toLowerCase())
          : (singleSelected && itemValue === singleSelected);
        const row = globalScope.document.createElement('div');
        row.className = 'editable-list-option-row';

        const option = globalScope.document.createElement('button');
        option.type = 'button';
        option.className = picker.multiSelect
          ? 'editable-list-option editable-list-option--multi'
          : 'editable-list-option';
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', isSelected ? 'true' : 'false');
        if (picker.multiSelect) {
          const checkbox = globalScope.document.createElement('span');
          checkbox.className = 'editable-list-checkbox';
          checkbox.setAttribute('aria-hidden', 'true');
          checkbox.dataset.checked = isSelected ? 'true' : 'false';
          const label = globalScope.document.createElement('span');
          label.className = 'editable-list-option-label';
          label.textContent = getItemLabel(item);
          option.appendChild(checkbox);
          option.appendChild(label);
          option.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            toggleMultiSelectValue(itemValue, { rerender: true });
          });
        } else {
          option.textContent = getItemLabel(item);
          option.addEventListener('click', () => {
            picker.setSelection(itemValue, { emit: true });
            picker.close();
          });
        }

        const deleteButton = globalScope.document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'editable-list-delete';
        deleteButton.textContent = deleteLabel;
        deleteButton.title = `${deleteLabel}${itemLabel} ${getItemDeleteLabel(item)}`;
        deleteButton.setAttribute('aria-label', `${deleteLabel}${itemLabel} ${getItemDeleteLabel(item)}`);
        deleteButton.disabled = picker.items.length <= minItems;
        deleteButton.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (typeof onDelete === 'function') {
            Promise.resolve(onDelete(itemValue, item)).catch(reportDeleteError);
          }
        });

        row.appendChild(option);
        row.appendChild(deleteButton);
        menu.appendChild(row);
      });
    }

    picker.render = (items = [], selectedValue = '') => {
      const normalizedItems = normalizeItems(items);
      picker.items = normalizedItems.length ? normalizedItems : getFallbackItems();

      if (trigger) {
        trigger.disabled = picker.items.length === 0;
      }
      if (picker.items.length === 0) {
        if (menu) {
          menu.innerHTML = '';
        }
        picker.setSelection(picker.multiSelect ? [] : '', { emit: false });
        picker.close();
        return;
      }

      if (picker.multiSelect) {
        const incoming = selectedValue !== undefined && selectedValue !== null && selectedValue !== ''
          ? parseMultiSelectValues(selectedValue)
          : parseMultiSelectValues(input?.value);
        const knownValues = dedupeKeepingOrder(incoming.map(getKnownItemValueByCaseInsensitive))
          .filter((value) => Boolean(findItemByValue(value)));
        const finalValues = knownValues.length
          ? knownValues
          : (picker.items.length ? [getNormalizedItemValue(picker.items[0])] : []);
        if (
          !menu
          || typeof menu.appendChild !== 'function'
          || typeof globalScope.document === 'undefined'
          || typeof globalScope.document.createElement !== 'function'
        ) {
          picker.setSelection(finalValues, { emit: false });
          return;
        }
        renderOptions(finalValues);
        picker.setSelection(finalValues, { emit: false });
        return;
      }

      const inputValue = normalizeValue(input?.value);
      const selected = normalizeValue(selectedValue)
        || (findItemByValue(inputValue) ? inputValue : '')
        || getNormalizedItemValue(picker.items[0])
        || '';

      if (
        !menu
        || typeof menu.appendChild !== 'function'
        || typeof globalScope.document === 'undefined'
        || typeof globalScope.document.createElement !== 'function'
      ) {
        picker.setSelection(selected, { emit: false });
        return;
      }

      renderOptions(selected);
      picker.setSelection(selected, { emit: false });
    };

    trigger?.addEventListener('click', (event) => {
      event.stopPropagation();
      editableListPickers.forEach((item) => {
        if (item !== picker) {
          item.close();
        }
      });
      picker.setOpen(!picker.open);
    });
    trigger?.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        picker.close();
      }
    });
    menu?.addEventListener('click', (event) => {
      event.stopPropagation();
    });

    editableListPickers.push(picker);
    return picker;
  }

  function closeEditableListPickers() {
    editableListPickers.forEach((picker) => picker.close());
  }

  function isClickInsideEditableListPicker(target) {
    return editableListPickers.some((picker) => Boolean(picker.root?.contains(target)));
  }

  globalScope.SidepanelEditableListPicker = {
    closeEditableListPickers,
    createEditableListPicker,
    isClickInsideEditableListPicker,
    normalizeEditableListValues,
    splitEditableListValues,
  };
})(window);
