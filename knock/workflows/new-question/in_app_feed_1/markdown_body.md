{% if total_activities > 1 %}
**{{ total_activities }} new Questions** on **{{ data.course_title | escape }}**
{% else %}
**{{ data.asker_name | escape }}** asked a Question on **{{ data.lesson_title | escape }}** in **{{ data.course_title | escape }}**: “{{ data.question_excerpt | escape }}”
{% endif %}
