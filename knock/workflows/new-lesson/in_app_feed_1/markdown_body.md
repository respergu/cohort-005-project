{% if total_activities > 1 -%}
**{{ total_activities }} new lessons** in **{{ data.course_title | escape }}**
{%- else -%}
New lesson in **{{ data.course_title | escape }}**: **{{ data.lesson_title | escape }}**
{%- endif %}
