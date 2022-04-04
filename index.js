const dotenv = require("dotenv");
const { Client } = require("@notionhq/client");

dotenv.config({ path: `${__dirname}/.env` });
const notion = new Client({ auth: process.env.NOTION_KEY });

const RECIPIES_DATABASE_ID = process.env.RECIPIES_DATABASE_ID;
const TRIGGER_BLOCK_ID = process.env.TRIGGER_BLOCK_ID;
const SELECTION_BLOCK_ID = process.env.SELECTION_BLOCK_ID;
const FILTER_LIST_BLOCK_ID = process.env.FILTER_LIST_BLOCK_ID;

const CACHE_DURATION = 1000 * 60 * 5;
let lastUpdatedRecipes = undefined;
let recipesCache = undefined;
let lastUpdatedDatabase = undefined;
let databaseCache = undefined;
let lastUpdatedFilterTags = undefined;
let filterTagsCache = undefined;

class RethrownError extends Error {
  constructor(message, error) {
    super(message);
    this.name = this.constructor.name;
    if (!error) throw new Error("RethrownError requires a message and error");
    this.original_error = error;
    this.stack_before_rethrow = this.stack;
    const message_lines = (this.message.match(/\n/g) || []).length + 1;
    this.stack =
      this.stack
        .split("\n")
        .slice(0, message_lines + 1)
        .join("\n") +
      "\n" +
      error.stack;
  }
}

async function main() {
  while (true) {
    await pollRandomRecipe();
    await checkTags();
  }
}

async function pollRandomRecipe() {
  try {
    const { triggered, triggerBlock } = await checkTrigger();
    if (triggered) {
      const triggerLabel = await setTriggerProcessing(triggerBlock);
      const selectionBlock = await getSelection();
      const selectedRecipeID = await checkSelectionForRecipe(selectionBlock);
      const recipes = await getRecipes();
      const filterTags = await fetchFilterTags();
      const selectedFilterTags = filterTags.filter((t) => t.to_do.checked);
      const selectedFilterTagsText = selectedFilterTags.map((t) =>
        getFilterTagText(t)
      );
      // Filter by tags
      let filteredRecipes = recipes.filter((r) => {
        const recipeTagsText = r.properties["Tags"].multi_select.map(
          (o) => o.name
        );
        return (
          selectedFilterTagsText.some((t) => recipeTagsText.includes(t)) &&
          r.id != selectedRecipeID
        );
      });
      // If no recipes after filtering by tags, choose one from all recipes
      if (filteredRecipes.length == 0) {
        if (selectedFilterTags.length > 0) {
          console.log(
            `No recipes available with tags: ${selectedFilterTagsText}`
          );
        } else {
          console.log(
            "No filters selected, choosing random recipe from database."
          );
        }
        filteredRecipes = recipes.filter((r) => r.id != selectedRecipeID);
      } else {
        console.log(
          `Choosing random recipe with tags in: ${selectedFilterTagsText}`
        );
      }
      const recipeIndex = Math.floor(Math.random() * filteredRecipes.length);
      const recipe = filteredRecipes[recipeIndex];
      await setSelection(recipe);
      await resetTrigger(triggerBlock, triggerLabel);
    }
  } catch (error) {
    console.error(error);
  }
}

async function checkTrigger() {
  try {
    const trigger = await notion.blocks.retrieve({
      block_id: TRIGGER_BLOCK_ID,
    });
    return {
      triggered: trigger.to_do.checked,
      triggerBlock: trigger,
    };
  } catch (error) {
    throw new RethrownError("Unable to fetch trigger", error);
  }
}

async function setTriggerProcessing(block) {
  try {
    let triggerLabel = block.to_do.text.reduce((l, t) => l + t.plain_text, "");
    await notion.blocks.update({
      block_id: block.id,
      to_do: {
        text: [
          {
            text: {
              content:
                triggerLabel +
                " (choosing random recipe, will uncheck when finished...)",
            },
          },
        ],
      },
    });
    return triggerLabel;
  } catch (error) {
    throw new RethrownError("Unable to update trigger block", error);
  }
}

async function getSelection() {
  try {
    return await notion.blocks.retrieve({
      block_id: SELECTION_BLOCK_ID,
    });
  } catch (error) {
    throw new RethrownError("Unable to get selection block", error);
  }
}

async function checkSelectionForRecipe(selection) {
  const text = selection?.paragraph?.text;
  if (!text) return;
  for (let richText of text) {
    const page = richText?.mention?.page;
    if (page) return page.id;
  }
}

async function getRecipes() {
  if (Date.now() - lastUpdatedRecipes < CACHE_DURATION) {
    return recipesCache;
  }
  const recipes = await fetchRecipes();
  recipesCache = recipes;
  lastUpdatedRecipes = Date.now();
  return recipes;
}

async function fetchRecipes() {
  const recipes = [];
  let cursor = undefined;

  while (true) {
    try {
      const { results, next_cursor } = await notion.databases.query({
        database_id: RECIPIES_DATABASE_ID,
        start_cursor: cursor,
      });
      recipes.push(...results);
      if (!next_cursor) {
        break;
      }
      cursor = next_cursor;
    } catch (error) {
      throw new RethrownError("Unable to fetch recipes", error);
    }
  }

  return recipes;
}

async function getDatabase() {
  if (Date.now() - lastUpdatedDatabase < CACHE_DURATION) {
    return databaseCache;
  }
  const database = await fetchDatabase();
  databaseCache = database;
  lastUpdatedDatabase = Date.now();
  return database;
}

async function fetchDatabase() {
  try {
    return await notion.databases.retrieve({
      database_id: RECIPIES_DATABASE_ID,
    });
  } catch (error) {
    throw new RethrownError("Unable to fetch recipe database", error);
  }
}

async function setSelection(recipe) {
  try {
    const selection = await notion.blocks.retrieve({
      block_id: SELECTION_BLOCK_ID,
    });

    await notion.blocks.update({
      block_id: selection.id,
      paragraph: {
        rich_text: [
          {
            mention: {
              page: {
                id: recipe.id,
              },
            },
          },
        ],
      },
    });
  } catch (error) {
    throw new RethrownError("Unable to set selection", error);
  }
}

async function resetTrigger(trigger, label) {
  try {
    await notion.blocks.update({
      block_id: trigger.id,
      to_do: {
        checked: false,
        text: [{ text: { content: label } }],
      },
    });
  } catch (error) {
    throw new RethrownError("Unable to reset trigger", error);
  }
}

async function checkTags() {
  try {
    const database = await getDatabase();
    const tagObjects = database.properties["Tags"].multi_select.options;
    const tagsText = tagObjects.map((t) => t.name);
    const filterTags = await getFilterTags();
    const filterTagsText = filterTags.map((t) => getFilterTagText(t));
    const tagsTextToAdd = tagsText.filter((t) => !filterTagsText.includes(t));
    if (tagsTextToAdd.length > 0) {
      await addTags(tagsTextToAdd);
    }
  } catch (error) {
    throw new RethrownError("Unable to check tags", error);
  }
}

async function getFilterTags() {
  if (Date.now() - lastUpdatedFilterTags < CACHE_DURATION) {
    return filterTagsCache;
  }
  const filterTags = await fetchFilterTags();
  filterTagsCache = filterTags;
  lastUpdatedFilterTags = Date.now();
  return filterTags;
}

async function fetchFilterTags() {
  const filterTags = [];
  let cursor = undefined;

  while (true) {
    try {
      const { results, next_cursor } = await notion.blocks.children.list({
        block_id: FILTER_LIST_BLOCK_ID,
        start_cursor: cursor,
      });
      filterTags.push(...results);
      if (!next_cursor) {
        break;
      }
      cursor = next_cursor;
    } catch (error) {
      console.error(`Unable to get blocks from filter tag list`, error);
      break;
    }
  }

  return filterTags;
}

function getFilterTagText(filterTag) {
  return filterTag.to_do.text.reduce((l, t) => l + t.plain_text, "");
}

async function addTags(tags) {
  try {
    const tagBlocks = tags.map((t) => ({
      object: "block",
      type: "to_do",
      to_do: {
        rich_text: [{ type: "text", text: { content: t } }],
      },
    }));
    await notion.blocks.children.append({
      block_id: FILTER_LIST_BLOCK_ID,
      children: tagBlocks,
    });

    // Be sure to invalidate tags cache, otherwise it will
    // add duplicates
    filterTagCache = undefined;
    lastUpdatedFilterTags = undefined;
    return;
  } catch (error) {
    throw new RethrownError("Unable to add filter tag block", error);
  }
}

main();
